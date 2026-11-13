/**
 * Planning and execution of sync passes.
 *
 * Three modes share one report shape:
 *
 * - `push` — this machine uploads into its own slot under `machines/<machine>/`.
 *   Purely additive: the remote is never rewritten and nothing is deleted.
 * - `pull` — the reverse, used to bootstrap a new machine. Reads from the shared
 *   tree, or from one machine's slot when `pullFrom` names a machine.
 * - `two-way` — upload and download against the shared tree, deciding each path
 *   from a stored baseline so "only I changed" is distinguishable from
 *   "only the other machine changed".
 *
 * Remote layout is `<root>/<item>/<rootTag>/<path>`, where rootTag records which
 * local root the file came from so a pull can rebuild an absolute path.
 *
 * @module @local/dsh-nas-sync/lib/sync
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

import { ITEMS, PULL_CAVEAT, TWO_WAY, directionOf, environment, machineId, resolveFromTag, rootTagFor } from './items.js'
import { CONFLICT, PULL, PUSH, conflictName, decide, isConflictArtifact } from './merge.js'

const MANIFEST_DIR = '.dsh-nas-sync'
const SKIP_DIRECTORIES = new Set(['node_modules', '.git'])

/** Explain the most likely reason a scope came back empty. */
const EMPTY_HINTS = {
  memory: '若 Mnemon 使用自定义 dataDir，该目录不在自动探测范围内。',
  modelConfig: '宿主未提供 settings 服务，或本 profile 没有模型配置行。',
  mcpServers: '本 profile 没有挂载 MCP 行。',
  skills: '未在 DSH_AGENTS_HOME/skills 或 DSH_HOME/skills 下发现技能。',
}

/** Convert a platform path to the forward-slash form used remotely. */
const remoteJoin = (...parts) => parts.filter(part => part !== '').join('/')

/** Remote-relative path for one absolute local file. */
function remotePathFor(env, itemKey, abs) {
  const tag = rootTagFor(env, abs)
  const root = tag === 'dsh' ? env.home
    : tag === 'agents' ? env.agentsHome
      : tag === 'home' ? homedir()
        : '/'
  const rel = relative(root, abs).split(sep).join('/')
  return remoteJoin(itemKey, tag, rel === '' ? basename(abs) : rel)
}

/** Split a remote-relative path into its item, root tag, and remainder. */
function splitRemotePath(rel) {
  const parts = rel.split('/')
  if (parts.length < 3) return null
  return { item: parts[0], tag: parts[1], rest: parts.slice(2).join('/') }
}

/** Yield every regular file below one directory, skipping dependency trees. */
async function* walkFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      yield* walkFiles(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

/** Hash one local file, or report it absent. */
async function localDigest(abs) {
  try {
    const info = await stat(abs)
    if (!info.isFile()) return undefined
    const bytes = await readFile(abs)
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: info.size,
      mtime: info.mtimeMs,
      read: async () => bytes,
    }
  } catch {
    return undefined
  }
}

/** Read one JSON manifest, treating absence or corruption as empty. */
function parseManifest(raw, warnings, label) {
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed?.entries ?? {}
  } catch {
    warnings.push(`${label} 不是有效 JSON，已当作空基线处理（会重新比对全部文件）。`)
    return {}
  }
}

/** Parse a WebDAV date header, tolerating junk. */
function parseDate(value) {
  if (value === null || value === undefined) return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : time
}

/** Scopes that take part in a run, i.e. every scope whose direction is not `off`. */
export function selectedItems(config) {
  return ITEMS.filter(item => directionOf(config, item) !== 'off')
}

/** Render bytes as a short human-readable string. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/** Resolve the directory names this configuration uses. */
function layout(config) {
  const base = String(config?.remoteDir ?? 'dsh-sync').replace(/^\/+|\/+$/g, '') || 'dsh-sync'
  return { machines: remoteJoin(base, 'machines'), shared: remoteJoin(base, 'shared') }
}

/** Collect one item's local entries, including modification times. */
async function collectItem(item, env, ctx, config, budget) {
  const entries = []
  const present = new Set()

  // A scope may carry its own remote target; everything else keeps the
  // `<item>/<rootTag>/<path>` layout inside the machine slot.
  const scopes = item.scopes === undefined ? null : await item.scopes(env, config)
  const configured = scopes !== null
    ? { trees: [], files: [] }
    : (item.paths === undefined ? {} : await item.paths(env, config))
  const trees = configured.trees ?? []
  const files = configured.files ?? []

  const add = async (abs, override) => {
    let info
    try {
      info = await stat(abs)
    } catch {
      return
    }
    if (!info.isFile()) return
    if (info.size > budget.maxBytes) {
      budget.oversized.push({ abs, size: info.size })
      return
    }
    entries.push({
      rel: override === undefined ? remotePathFor(env, item.key, abs) : override.rel,
      absolute: override !== undefined && override.absolute === true,
      abs,
      size: info.size,
      mtime: info.mtimeMs,
      read: async () => await readFile(abs),
    })
  }

  if (scopes !== null) {
    for (const scope of scopes) {
      let info
      try {
        info = await stat(scope.abs)
      } catch {
        present.add(scope.abs)
        continue
      }
      present.add(scope.abs)
      if (info.isDirectory()) {
        for await (const abs of walkFiles(scope.abs)) {
          const inner = relative(scope.abs, abs).split(sep).join('/')
          const override = scope.remote === ''
            ? undefined
            : { rel: remoteJoin(scope.remote, inner), absolute: true }
          await add(abs, override)
        }
      } else {
        const override = scope.remote === ''
          ? undefined
          : { rel: scope.remote, absolute: true }
        await add(scope.abs, override)
      }
    }
  }

  for (const tree of trees) {
    let info
    try {
      info = await stat(tree)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    present.add(tree)
    for await (const abs of walkFiles(tree)) await add(abs)
  }

  for (const file of files) {
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    present.add(file)
    await add(file)
  }

  if (item.generated !== undefined) {
    for (const artifact of await item.generated(env, ctx, config)) {
      const content = Buffer.from(artifact.content, 'utf8')
      entries.push({
        rel: remoteJoin(item.key, artifact.name),
        abs: null,
        size: content.length,
        mtime: Date.now(),
        read: async () => content,
      })
    }
  }

  const missing = [...trees, ...files].filter(path => !present.has(path))
  return { entries, missing }
}

/**
 * Build the local inventory without touching the network.
 * @returns per-item entries, byte totals, and configured paths that were absent.
 */
export async function plan(config, ctx) {
  const env = environment()
  const budget = {
    maxBytes: Math.max(1, Number(config?.maxFileMB ?? 200)) * 1024 * 1024,
    oversized: [],
  }
  const collected = []
  for (const item of selectedItems(config)) {
    const { entries, missing } = await collectItem(item, env, ctx, config, budget)
    collected.push({ item, entries, missing })
  }
  return {
    env,
    machine: await machineId(env, config?.machineName),
    items: collected,
    files: collected.reduce((total, one) => total + one.entries.length, 0),
    bytes: collected.reduce((total, one) => total + one.entries.reduce((sum, entry) => sum + entry.size, 0), 0),
    oversized: budget.oversized,
  }
}

/** Restrict a plan to the caller's item filter. */
function restrict(items, only) {
  if (!Array.isArray(only) || only.length === 0) return items
  const wanted = new Set(only)
  return items.filter(one => wanted.has(one.item.key))
}

/** Shared per-item report scaffold. */
function newItemReport(one) {
  return {
    key: one.item.key,
    title: one.item.zh ?? one.item.en ?? one.item.key,
    files: one.entries.length,
    bytes: one.entries.reduce((sum, entry) => sum + entry.size, 0),
    uploaded: 0,
    downloaded: 0,
    unchanged: 0,
    conflicts: 0,
    missing: one.missing,
    notes: [],
    error: null,
  }
}

/** Assemble the final report from per-item reports. */
function finish(report) {
  return {
    ok: report.errors.length === 0,
    ...report,
    totals: {
      files: report.items.reduce((sum, one) => sum + one.files, 0),
      bytes: report.items.reduce((sum, one) => sum + one.bytes, 0),
      uploaded: report.items.reduce((sum, one) => sum + one.uploaded, 0),
      downloaded: report.items.reduce((sum, one) => sum + one.downloaded, 0),
      unchanged: report.items.reduce((sum, one) => sum + one.unchanged, 0),
      conflicts: report.items.reduce((sum, one) => sum + one.conflicts, 0),
    },
  }
}

/**
 * Upload this machine's content into its own slot. Never rewrites remote files,
 * never deletes anything.
 */
export async function push(config, ctx, client, options = {}) {
  const dryRun = options.dryRun === true
  const local = await plan(config, ctx)
  const items = restrict(local.items, options.only)
  const { machines } = layout(config)
  const root = remoteJoin(machines, local.machine)
  const manifestRemote = remoteJoin(root, MANIFEST_DIR, 'manifest.json')
  const warnings = []
  const errors = []

  for (const one of items) {
    if (one.entries.length > 0) continue
    warnings.push(`${one.item.zh ?? one.item.key}：本次没有找到可同步内容。${EMPTY_HINTS[one.item.key] ?? ''}`.trim())
  }
  if (client.insecure) warnings.push('WebDAV 使用 http：口令与文件内容在链路上是明文，建议改用 https。')
  if (items.some(one => one.item.key === 'credentials' && one.entries.length > 0)) {
    warnings.push('本次包含 .credentials.yaml，NAS 上的副本可被任何有读权限者直接使用。')
  }

  // A preview must predict the real run, so it reads the remote manifest too when
  // one is reachable. Without a destination it degrades to a local inventory and
  // says so, instead of pretending everything is new.
  let manifest = {}
  try {
    await client.probe()
    manifest = parseManifest(await client.getText(manifestRemote), warnings, '远端 manifest')
  } catch (error) {
    if (!dryRun) throw error
    warnings.push(`预演读不到远端清单（${String(error?.message ?? error)}），下面按「远端为空」估算。`)
  }

  const nextManifest = { ...manifest }
  const itemReports = []
  for (const one of items) {
    const itemReport = newItemReport(one)
    try {
      for (const entry of one.entries) {
        const sha256 = createHash('sha256').update(await entry.read()).digest('hex')
        if (manifest[entry.rel]?.sha256 === sha256) {
          itemReport.unchanged += 1
          continue
        }
        const target = entry.absolute === true ? entry.rel : remoteJoin(root, entry.rel)
        if (!dryRun) await client.put(target, await entry.read())
        nextManifest[entry.rel] = { sha256, size: entry.size, at: new Date().toISOString() }
        itemReport.uploaded += 1
      }
    } catch (error) {
      itemReport.error = String(error?.message ?? error)
      errors.push(`${one.item.key}: ${itemReport.error}`)
    }
    itemReports.push(itemReport)
  }

  if (!dryRun) {
    const body = Buffer.from(JSON.stringify({
      version: 2, machine: local.machine, mode: 'push',
      updatedAt: new Date().toISOString(), entries: nextManifest,
    }, null, 2), 'utf8')
    await client.put(manifestRemote, body)
  }

  return finish({
    mode: 'push', dryRun, machine: local.machine, endpoint: client.origin, remoteRoot: root,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    items: itemReports, oversized: local.oversized, warnings, errors, conflicts: [], notes: [],
  })
}

/**
 * Download remote content into this machine, for bootstrapping or restoring.
 * @param config - plugin Config.
 * @param ctx - Host context, unused here but kept for signature symmetry.
 * @param client - destination client.
 * @param options - `dryRun` and `only`.
 */
export async function pull(config, ctx, client, options = {}) {
  const dryRun = options.dryRun === true
  const env = environment()
  const machine = await machineId(env, config?.machineName)
  const { machines, shared } = layout(config)
  const from = String(config?.pullFrom ?? '').trim()
  const source = from === '' ? shared : remoteJoin(machines, from)
  const overwrite = String(config?.overwrite ?? 'missing')
  const warnings = []
  const errors = []
  const notes = []
  const itemReports = []

  if (client.insecure) warnings.push('WebDAV 使用 http：口令与文件内容在链路上是明文，建议改用 https。')
  if (!dryRun) await client.probe()

  for (const item of restrict(selectedItems(config), options.only)) {
    const itemReport = {
      key: item.key, title: item.zh ?? item.en ?? item.key,
      files: 0, bytes: 0, uploaded: 0, downloaded: 0, unchanged: 0,
      conflicts: 0, missing: [], notes: [], error: null,
    }
    if (PULL_CAVEAT[item.key] !== undefined) itemReport.notes.push(PULL_CAVEAT[item.key])
    try {
      const remoteFiles = await client.walk(remoteJoin(source, item.key))
      for (const remote of remoteFiles) {
        const full = remoteJoin(item.key, remote.path)
        if (isConflictArtifact(full)) continue
        const parts = splitRemotePath(full)
        // Only `<item>/<rootTag>/…` maps back to a local path; exports do not.
        if (parts === null || parts.item !== item.key) continue
        itemReport.files += 1
        const abs = resolveFromTag(env, parts.tag, parts.rest)
        const existing = await localDigest(abs)
        const remoteMtime = parseDate(remote.lastModified)
        const write = existing === undefined
          || overwrite === 'always'
          || (overwrite === 'newer' && remoteMtime !== undefined && remoteMtime > existing.mtime)
        if (!write) {
          itemReport.unchanged += 1
          continue
        }
        itemReport.bytes += remote.size ?? 0
        if (!dryRun) {
          const bytes = await client.getBytes(remoteJoin(source, full))
          if (bytes === null) continue
          await mkdir(dirname(abs), { recursive: true })
          await writeFile(abs, bytes)
        }
        itemReport.downloaded += 1
      }
    } catch (error) {
      itemReport.error = String(error?.message ?? error)
      errors.push(`${item.key}: ${itemReport.error}`)
    }
    itemReports.push(itemReport)
  }

  if (itemReports.every(one => one.files === 0)) {
    notes.push(`远端 ${source} 下没有找到所选内容；首次使用时请先在已有数据的机器上以 push 或 two-way 上传一次。`)
  }

  return finish({
    mode: 'pull', dryRun, machine, endpoint: client.origin, remoteRoot: source,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    items: itemReports, oversized: [], warnings, errors, conflicts: [],
    notes,
  })
}

/**
 * Reconcile the shared tree with this machine using a stored baseline.
 *
 * Items outside {@link TWO_WAY} keep push-only behaviour: they are uploaded but
 * never overwritten locally, because their content embeds machine-specific
 * values such as absolute paths or per-machine tokens.
 */
export async function twoWay(config, ctx, client, options = {}) {
  const dryRun = options.dryRun === true
  const local = await plan(config, ctx)
  const items = restrict(local.items, options.only)
  const { shared } = layout(config)
  const env = local.env
  const baseRemote = remoteJoin(shared, MANIFEST_DIR, `base-${local.machine}.json`)
  const policy = String(config?.conflict ?? 'both')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')
  const warnings = []
  const errors = []
  const notes = []
  const conflicts = []

  if (client.insecure) warnings.push('WebDAV 使用 http：口令与文件内容在链路上是明文，建议改用 https。')
  if (items.some(one => one.item.key === 'credentials' && one.entries.length > 0)) {
    warnings.push('本次包含 .credentials.yaml；双向模式下其他机器会覆盖它，请确认这是你想要的。')
  }

  let base = {}
  if (!dryRun) {
    await client.probe()
    base = parseManifest(await client.getText(baseRemote), warnings, '同步基线')
  }
  const nextBase = { ...base }
  const itemReports = []

  for (const one of items) {
    const key = one.item.key
    const shareable = TWO_WAY.has(key)
    const itemReport = newItemReport(one)
    if (!shareable) itemReport.notes.push('只上传不下载：内容含本机专属信息，双向覆盖会出错。')
    try {
      const localByRel = new Map(one.entries.map(entry => [entry.rel, entry]))
      const remoteByRel = new Map()
      if (shareable) {
        for (const remote of await client.walk(remoteJoin(shared, key))) {
          const full = remoteJoin(key, remote.path)
          if (isConflictArtifact(full)) continue
          remoteByRel.set(full, remote)
        }
      }
      const allRels = new Set([...localByRel.keys(), ...remoteByRel.keys()])

      for (const rel of allRels) {
        const localEntry = localByRel.get(rel)
        const remote = remoteByRel.get(rel)
        const localSha = localEntry === undefined
          ? undefined
          : createHash('sha256').update(await localEntry.read()).digest('hex')
        let remoteSha
        if (shareable && remote !== undefined) {
          const bytes = await client.getBytes(remoteJoin(shared, rel))
          remoteSha = bytes === null ? undefined : createHash('sha256').update(bytes).digest('hex')
        }

        const verdict = shareable
          ? decide({
            base: base[rel]?.sha256,
            local: localSha,
            remote: remoteSha,
            localMtime: localEntry?.mtime,
            remoteMtime: parseDate(remote?.lastModified),
          }, policy)
          : decide({ base: base[rel]?.sha256, local: localSha, remote: base[rel]?.sha256 }, 'local')

        if (verdict.action === PUSH) {
          if (!dryRun) await client.put(remoteJoin(shared, rel), await localEntry.read())
          nextBase[rel] = { sha256: localSha, size: localEntry.size, at: new Date().toISOString() }
          itemReport.uploaded += 1
          continue
        }
        if (verdict.action === PULL) {
          // An absolute target is an export: it has no reverse mapping to a local path.
          if (localEntry === undefined || localEntry.absolute === true) continue
          const parts = splitRemotePath(rel)
          if (parts === null) continue
          const abs = resolveFromTag(env, parts.tag, parts.rest)
          let size = remote?.size ?? 0
          if (!dryRun) {
            const bytes = await client.getBytes(remoteJoin(shared, rel))
            if (bytes === null) continue
            size = bytes.length
            await mkdir(dirname(abs), { recursive: true })
            await writeFile(abs, bytes)
          }
          nextBase[rel] = { sha256: remoteSha, size, at: new Date().toISOString() }
          itemReport.downloaded += 1
          continue
        }
        if (verdict.action === CONFLICT) {
          itemReport.conflicts += 1
          const artifact = conflictName(rel, local.machine, stamp)
          conflicts.push({ rel, resolution: artifact })
          const parts = splitRemotePath(rel)
          if (!dryRun && parts !== null) {
            const abs = resolveFromTag(env, parts.tag, parts.rest)
            if (localEntry !== undefined) {
              const localBytes = await localEntry.read()
              await client.put(remoteJoin(shared, artifact), localBytes)
              await writeFile(`${abs}.conflict-${stamp}`, localBytes).catch(() => {})
            }
            const remoteBytes = await client.getBytes(remoteJoin(shared, rel))
            if (remoteBytes !== null) {
              await mkdir(dirname(abs), { recursive: true })
              await writeFile(abs, remoteBytes)
              nextBase[rel] = { sha256: remoteSha, size: remoteBytes.length, at: new Date().toISOString() }
            }
          }
          continue
        }
        if (verdict.action === 'none') {
          itemReport.unchanged += 1
          if (localSha !== undefined && base[rel]?.sha256 !== localSha) {
            nextBase[rel] = { sha256: localSha, size: localEntry.size, at: new Date().toISOString() }
          }
          continue
        }
        // Deletions are reported, never propagated.
        itemReport.notes.push(`${rel}: ${verdict.reason}`)
      }
    } catch (error) {
      itemReport.error = String(error?.message ?? error)
      errors.push(`${key}: ${itemReport.error}`)
    }
    itemReports.push(itemReport)
  }

  if (!dryRun) {
    const body = Buffer.from(JSON.stringify({
      version: 2, machine: local.machine, mode: 'two-way',
      updatedAt: new Date().toISOString(), entries: nextBase,
    }, null, 2), 'utf8')
    await client.put(baseRemote, body)
  }

  return finish({
    mode: 'two-way', dryRun, machine: local.machine, endpoint: client.origin, remoteRoot: shared,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    items: itemReports, oversized: local.oversized, warnings, errors, conflicts, notes,
  })
}

/** Merge the per-direction reports into one report with the usual shape. */
function mergeReports(parts) {
  const present = parts.filter(part => part !== undefined)
  if (present.length === 0) {
    return {
      ok: true, mode: 'none', dryRun: false, machine: '', endpoint: '', remoteRoot: '',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      items: [], oversized: [], warnings: [], errors: [], conflicts: [], notes: [],
      totals: { files: 0, bytes: 0, uploaded: 0, downloaded: 0, unchanged: 0, conflicts: 0 },
    }
  }
  if (present.length === 1) return present[0]
  const modes = [...new Set(present.map(part => part.mode))]
  return finish({
    mode: modes.length === 1 ? modes[0] : 'mixed',
    dryRun: present[0].dryRun,
    machine: present[0].machine,
    endpoint: present[0].endpoint,
    remoteRoot: [...new Set(present.map(part => part.remoteRoot))].join(' + '),
    startedAt: present[0].startedAt,
    finishedAt: new Date().toISOString(),
    items: present.flatMap(part => part.items),
    oversized: present.flatMap(part => part.oversized),
    warnings: present.flatMap(part => part.warnings),
    errors: present.flatMap(part => part.errors),
    conflicts: present.flatMap(part => part.conflicts),
    notes: present.flatMap(part => part.notes),
  })
}

/**
 * Run every selected scope in its own configured direction.
 *
 * `options.mode` overrides every scope's direction for this call, which is what
 * the `nas_sync` tool exposes; the settings page leaves it unset so each row
 * keeps its own direction.
 */
export async function run(config, ctx, client, options = {}) {
  const override = typeof options.mode === 'string' && options.mode !== '' ? options.mode : null
  const requested = Array.isArray(options.only) && options.only.length > 0 ? options.only : null
  const scope = new Set(requested === null ? ITEMS.map(item => item.key) : requested)
  const groups = { push: [], pull: [], 'two-way': [] }
  for (const item of ITEMS) {
    if (!scope.has(item.key)) continue
    const direction = override ?? directionOf(config, item)
    if (direction === 'off' || groups[direction] === undefined) continue
    groups[direction].push(item.key)
  }

  const skipped = [...scope].filter(key => {
    const item = ITEMS.find(entry => entry.key === key)
    if (item === undefined) return false
    const direction = override ?? directionOf(config, item)
    return direction === 'off'
  })

  const parts = []
  if (groups.push.length > 0) parts.push(await push(config, ctx, client, { ...options, only: groups.push }))
  if (groups.pull.length > 0) parts.push(await pull(config, ctx, client, { ...options, only: groups.pull }))
  if (groups['two-way'].length > 0) parts.push(await twoWay(config, ctx, client, { ...options, only: groups['two-way'] }))
  const merged = mergeReports(parts)
  if (parts.length === 0) {
    merged.warnings = skipped.length > 0
      ? [`以下内容项当前处于关闭状态，没有参与本次执行：${skipped.join('、')}。请在设置页打开对应开关。`]
      : ['所选范围内没有可执行的内容项。']
  }
  return merged
}
