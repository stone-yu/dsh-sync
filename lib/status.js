/**
 * Build what the settings page renders.
 *
 * Two phases, because they cost very different amounts:
 *
 * - {@link describeScopes} reads only configuration, so the page can paint names,
 *   directions and remote paths immediately.
 * - {@link buildStatus} adds the numbers, which need a local walk, a sha256 of
 *   every file, and one PROPFIND per remote directory. Those are the slow parts;
 *   results are cached so re-opening the page is instant.
 *
 * @module @local/dsh-nas-sync/lib/status
 */
import { createHash } from 'node:crypto'

import { ITEMS, TWO_WAY, allowedDirections, directionOf, environment, machineId } from './items.js'
import { plan, selectedItems } from './sync.js'

/** Above this many local files the per-file digest comparison is skipped. */
const HASH_LIMIT = 5000

/** How long a remote directory listing may be reused. */
const WALK_TTL_MS = 15000

/** Digest cache entries beyond this are dropped wholesale. */
const DIGEST_LIMIT = 20000

/** Remote listings keyed by origin + path, with the time they were taken. */
const walkCache = new Map()

/** Local file digests keyed by absolute path + size + mtime. */
const digestCache = new Map()

/** Drop every cached listing, so the next compare re-reads the remote. */
export function invalidateRemoteCache() {
  walkCache.clear()
}

/** Read one JSON manifest, tolerating absence and corruption. */
async function readManifest(client, rel) {
  const raw = await client.getText(rel)
  if (raw === null) return {}
  try {
    return JSON.parse(raw)?.entries ?? {}
  } catch {
    return {}
  }
}

/** List one remote collection through the shared cache. */
async function cachedWalk(client, path, budget, fresh) {
  const key = `${client.origin}|${path}`
  if (!fresh) {
    const hit = walkCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < WALK_TTL_MS) return hit.files
  }
  const files = await client.walk(path, budget)
  walkCache.set(key, { at: Date.now(), files })
  return files
}

/** sha256 of one local entry, reusing a digest when size and mtime are unchanged. */
async function digestOf(entry) {
  if (entry.abs === null) {
    return createHash('sha256').update(await entry.read()).digest('hex')
  }
  const key = `${entry.abs}|${entry.size}|${Math.round(entry.mtime ?? 0)}`
  const hit = digestCache.get(key)
  if (hit !== undefined) return hit
  const sha = createHash('sha256').update(await entry.read()).digest('hex')
  if (digestCache.size > DIGEST_LIMIT) digestCache.clear()
  digestCache.set(key, sha)
  return sha
}

/**
 * Resolve the remote root and manifest a direction compares against.
 * @returns `{ root, manifest }` relative to the WebDAV base.
 */
function locate(direction, base, machine, pullFrom) {
  if (direction === 'two-way') {
    return { root: `${base}/shared`, manifest: `${base}/shared/.dsh-nas-sync/base-${machine}.json` }
  }
  if (direction === 'pull') {
    const root = pullFrom === '' ? `${base}/shared` : `${base}/machines/${pullFrom}`
    return { root, manifest: `${root}/.dsh-nas-sync/manifest.json` }
  }
  const root = `${base}/machines/${machine}`
  return { root, manifest: `${root}/.dsh-nas-sync/manifest.json` }
}

/**
 * Build the configuration-only snapshot: no disk walk, no network.
 *
 * Every numeric field is `null` so the page can render immediately and fill the
 * numbers once the comparison finishes.
 * @param config - plugin Config.
 * @returns `{ rows, connection, ... }` ready to render.
 */
export async function describeScopes(config) {
  const env = environment()
  const machine = await machineId(env, config?.machineName)
  const pulled = String(config?.pullFrom ?? '').trim()
  const base = String(config?.remoteDir ?? 'dsh-sync').replace(/^\/+|\/+$/g, '') || 'dsh-sync'
  const enabledKeys = new Set(selectedItems(config).map(item => item.key))

  const rows = ITEMS.map(item => {
    const direction = directionOf(config, item)
    return {
      key: item.key,
      title: item.zh ?? item.en ?? item.key,
      direction,
      configuredDirection: String(config?.directions?.[item.key] ?? 'push'),
      allowed: allowedDirections(item),
      twoWay: TWO_WAY.has(item.key),
      risk: item.risk ?? null,
      note: item.note?.zh ?? '',
      enabled: enabledKeys.has(item.key),
      localFiles: null,
      localBytes: null,
      remoteFiles: null,
      pending: null,
      root: locate(direction === 'off' ? String(config?.directions?.[item.key] ?? 'push') : direction, base, machine, pulled).root,
      remotePath: `${item.key}/`,
      status: direction === 'off' ? 'off' : 'loading',
      message: '',
      partial: true,
    }
  })

  return {
    partial: true,
    configured: String(config?.url ?? '').trim() !== '',
    base,
    machine,
    pulled,
    root: base,
    extraDirs: Array.isArray(config?.extraDirs) ? config.extraDirs : [],
    memoryDirs: Array.isArray(config?.memoryDirs) ? config.memoryDirs : [],
    connection: {
      machineName: String(config?.machineName ?? ''),
      url: String(config?.url ?? ''),
      username: String(config?.username ?? ''),
      hasPassword: String(config?.password ?? '') !== '',
      overwrite: String(config?.overwrite ?? 'missing'),
      conflict: String(config?.conflict ?? 'both'),
      maxFileMB: Number(config?.maxFileMB ?? 200),
    },
    rows,
    totals: null,
    remoteError: null,
    refreshedAt: new Date().toISOString(),
    hashLimit: HASH_LIMIT,
  }
}

/**
 * Fill the numbers into a described snapshot.
 *
 * @param config - plugin Config.
 * @param ctx - Host context, used by generated items.
 * @param client - WebDAV client, or `null` when no destination is configured.
 * @param options - `compare: false` skips the network, `fresh: true` bypasses caches.
 */
export async function buildStatus(config, ctx, client, options = {}) {
  const snapshot = await describeScopes(config)
  const rows = snapshot.rows
  const byKey = new Map(rows.map(row => [row.key, row]))
  const local = await plan(config, ctx)
  const localByKey = new Map(local.items.map(one => [one.item.key, one]))

  let remoteError = null

  const fillLocal = () => {
    for (const row of rows) {
      const collected = localByKey.get(row.key)
      const entries = collected?.entries ?? []
      row.localFiles = entries.length
      row.localBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
      row.partial = false
    }
  }

  if (client === null) {
    fillLocal()
    remoteError = '尚未配置 WebDAV 地址，只显示本地清点结果。'
    for (const row of rows) {
      if (row.direction !== 'off') {
        row.status = 'off'
        row.message = '未配置远端'
      }
    }
  } else if (options.compare === false) {
    fillLocal()
    for (const row of rows) if (row.direction !== 'off') row.status = 'unknown'
  } else {
    const fresh = options.fresh === true
    try {
      await client.probe()
      const hashAllowed = local.files <= HASH_LIMIT

      // Manifests first, once per distinct file, so per-item work can run in parallel.
      const manifestRels = new Set()
      for (const row of rows) {
        if (!row.enabled) continue
        manifestRels.add(locate(row.direction === 'off' ? row.configuredDirection : row.direction,
          snapshot.base, snapshot.machine, snapshot.pulled).manifest)
      }
      const manifests = new Map()
      await Promise.all([...manifestRels].map(async rel => {
        manifests.set(rel, await readManifest(client, rel))
      }))

      await Promise.all(rows.map(async row => {
        const enabled = row.enabled && row.direction !== 'off'
        const collected = localByKey.get(row.key)
        const entries = collected?.entries ?? []
        row.localFiles = entries.length
        row.localBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
        row.partial = false
        if (!enabled) {
          row.status = 'off'
          return
        }

        const where = locate(row.direction, snapshot.base, snapshot.machine, '')
        try {
          let remoteCount = (await cachedWalk(client, `${row.root}/${row.key}`, { files: 0, maxFiles: 50000 }, fresh)).length
          // Scopes with their own remote target live outside the item subtree.
          const scoped = ITEMS.find(entry => entry.key === row.key)
          if (typeof scoped?.scopes === 'function') {
            for (const scope of await scoped.scopes(environment(), config)) {
              if (scope.remote === '') continue
              remoteCount += (await cachedWalk(client, scope.remote, { files: 0, maxFiles: 50000 }, fresh)).length
            }
          }
          row.remoteFiles = remoteCount
        } catch {
          row.remoteFiles = null
        }

        if (row.direction === 'pull') {
          row.status = 'pull-ready'
          row.message = row.remoteFiles === null ? '无法枚举远端' : `将下载 ${row.remoteFiles} 个文件`
          return
        }
        if (!hashAllowed) {
          row.status = 'synced'
          row.message = `文件数超过 ${HASH_LIMIT}，已跳过逐文件比对`
          return
        }

        const manifest = manifests.get(where.manifest) ?? {}
        let pending = 0
        for (const entry of entries) {
          const sha = await digestOf(entry)
          if (manifest[entry.rel]?.sha256 !== sha) pending += 1
        }
        row.pending = pending
        if (pending === 0 && (row.remoteFiles === 0 || row.remoteFiles === null)) {
          row.status = 'pending'
          row.message = '远端还没有该项内容'
        } else {
          row.status = pending === 0 ? 'synced' : 'pending'
        }
      }))
    } catch (error) {
      remoteError = String(error?.message ?? error)
      fillLocal()
      for (const row of rows) if (row.enabled) row.status = 'unknown'
    }
  }

  const activeRows = rows.filter(row => row.direction !== 'off')
  snapshot.partial = false
  snapshot.remoteError = remoteError
  snapshot.refreshedAt = new Date().toISOString()
  snapshot.totals = {
    localFiles: rows.reduce((sum, row) => sum + (row.localFiles ?? 0), 0),
    localBytes: rows.reduce((sum, row) => sum + (row.localBytes ?? 0), 0),
    pending: activeRows.reduce((sum, row) => sum + (row.pending ?? 0), 0),
    enabledItems: activeRows.length,
    directions: {
      push: rows.filter(row => row.direction === 'push').length,
      pull: rows.filter(row => row.direction === 'pull').length,
      'two-way': rows.filter(row => row.direction === 'two-way').length,
    },
  }
  return snapshot
}
