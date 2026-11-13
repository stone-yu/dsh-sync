/**
 * Remote sync: copy selected DSH content to a WebDAV collection, machine by machine.
 *
 * The plugin declares its whole selectable surface as Config, so DSH renders the
 * settings form for it; the same operation is exposed to the agent as the
 * `nas_sync` tool.
 *
 * Only `@deepseek-ai/schemastery` is imported. Harness runtime packages resolve
 * from the dsh installation, which a profile-installed bundle cannot reach, so
 * the tool definition is written out as plain JSON Schema instead of going
 * through `@deepseek-ai/dsh-tools`.
 *
 * @module @local/dsh-nas-sync
 */
import z from '@deepseek-ai/schemastery'

import { DIRECTIONS, ITEMS, MACHINE_NAME_PATTERN, allowedDirections } from './lib/items.js'
import { buildStatus, describeScopes, invalidateRemoteCache } from './lib/status.js'
import { formatBytes, run } from './lib/sync.js'
import { WebdavClient, WebdavError } from './lib/webdav.js'

/** Services this plugin needs at registration time. */
export const inject = ['tools']

/** One participation switch per standalone scope. */
const itemEnabled = Object.fromEntries(ITEMS.map(item => [
  item.key,
  z.boolean()
    .default(item.default === true)
    .volatile()
    .description(`${item.zh}｜是否参与同步`),
]))

/** One direction per standalone scope; `off` is only produced when the switch is off. */
const itemDirections = Object.fromEntries(ITEMS.map(item => [
  item.key,
  z.string()
    .default('push')
    .volatile()
    .description(`${item.zh}｜同步方向（${allowedDirections(item).filter(value => value !== 'off').join(' / ')}）`),
]))

/** Destination, scope selection, and limits. */
export const Config = z.object({
  url: z.string()
    .default('')
    .volatile()
    .description('WebDAV 集合地址，例如 https://nas.example.com/dav/dsh。留空则只能做本地预演。'),
  username: z.string().default('').volatile().description('WebDAV 用户名，匿名访问留空。'),
  password: z.string().default('').volatile().description('WebDAV 密码。'),
  machineName: z.string()
    .default('')
    .volatile()
    .description('设备名称（纯英文），决定远端 machines/ 下的目录名。留空则自动生成。'),
  remoteDir: z.string().default('dsh-sync').volatile().description('远端根目录下的备份子目录名。'),
  pullFrom: z.string().default('').volatile().description('pull 的来源：留空用共享区；填某台机器的槽位名则从该机器的备份槽拉取。'),
  overwrite: z.string().default('missing').volatile().description('pull 覆盖策略：missing（只补缺失）｜newer（远端更新才覆盖）｜always（总是覆盖）。'),
  conflict: z.string().default('both').volatile().description('two-way 冲突策略：both（保留双方，冲突副本另存）｜newer（取较新）｜local（保本地）｜remote（保远端）。'),
  maxFileMB: z.number().default(200).volatile().description('单个文件体积上限（MB），超过则跳过并计入报告。'),
  dryRun: z.boolean().default(false).volatile().description('只计算差异、不上传，用于确认范围与体积。'),
  enabled: z.object(itemEnabled).description('同步内容：每项的参与开关。'),
  extraDirs: z.array(z.object({
    path: z.string().required(),
    remote: z.string().default(''),
  }))
    .default([])
    .volatile()
    .description('「其他文件目录」的路径列表。remote 为该路径在 WebDAV 根下的目标位置，留空则放进本机槽位。'),
  memoryDirs: z.array(z.string())
    .default([])
    .volatile()
    .description('「记忆」的存储目录。留空则自动探测；支持 ~ 表示用户主目录。'),
  items: z.object(itemDirections)
    .description('同步内容的方向：push 只上传；pull 只下载；two-way 双向。开关关闭时该项不参与。'),
})

/**
 * Read the live Config into a plain object.
 *
 * Every field is `.volatile()`, so a save applies in place instead of restarting
 * the plugin. Downstream code only ever sees this snapshot.
 * @param config - the volatile Config value.
 * @returns plain values, safe to pass to the sync engine.
 */
function readConfig(config) {
  const items = {}
  const rawDirections = {}
  const rawEnabled = {}
  const partsOut = {}
  const groupsOut = {}
  const directions = config?.items ?? {}
  const switches = config?.enabled ?? {}
  const partRefs = config?.parts ?? {}

  /** Read one volatile field, tolerating a plain value or absence. */
  const read = ref => (typeof ref?.get === 'function' ? ref.get() : undefined)

  for (const item of ITEMS) {
    const rawDirection = read(directions[item.key])
    const rawSwitch = read(switches[item.key])
    // A configuration written before switches existed stored booleans in `items`;
    // an explicit `off` there still means "do not participate".
    const enabled = rawSwitch === undefined
      ? (rawDirection === false ? false : rawDirection === 'off' ? false : true)
      : rawSwitch === true
    const direction = typeof rawDirection === 'string' && rawDirection !== 'off' ? rawDirection : 'push'
    items[item.key] = enabled ? direction : 'off'
    rawDirections[item.key] = direction
    rawEnabled[item.key] = enabled
  }

  return {
    url: read(config?.url) ?? '',
    username: read(config?.username) ?? '',
    password: read(config?.password) ?? '',
    machineName: read(config?.machineName) ?? '',
    remoteDir: read(config?.remoteDir) ?? 'dsh-sync',
    pullFrom: read(config?.pullFrom) ?? '',
    overwrite: read(config?.overwrite) ?? 'missing',
    conflict: read(config?.conflict) ?? 'both',
    maxFileMB: read(config?.maxFileMB) ?? 200,
    dryRun: read(config?.dryRun) === true,
    extraDirs: (() => {
      const value = read(config?.extraDirs)
      if (!Array.isArray(value)) return []
      const out = []
      for (const entry of value) {
        // A configuration written before per-path remotes stored bare strings.
        if (typeof entry === 'string') {
          out.push({ path: entry, remote: '' })
          continue
        }
        if (entry === null || typeof entry !== 'object') continue
        out.push({ path: String(entry.path ?? ''), remote: String(entry.remote ?? '') })
      }
      return out
    })(),
    memoryDirs: (() => {
      const value = read(config?.memoryDirs)
      return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : []
    })(),
    items,
    directions: rawDirections,
    enabled: rawEnabled,
    parts: partsOut,
    groups: groupsOut,
  }
}

/** Tool call parameters. Exported so the schema can be checked against the Host's supported subset. */
export const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['plan', 'run'],
      description: 'plan previews the difference locally; run uploads changed files.',
    },
    mode: {
      type: 'string',
      enum: ['push', 'pull', 'two-way'],
      description: 'Override the configured direction for this call.',
    },
    items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Restrict this call to these scope keys, for example ["sessions"] or ["conversations"] for the whole group. Omit for every enabled scope.',
    },
    dryRun: {
      type: 'boolean',
      description: 'Force a preview even for action "run".',
    },
  },
  required: ['action'],
}

/** Tool result shape. Exported for the same reason as {@link PARAMETERS}. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    mode: { type: 'string' },
    dryRun: { type: 'boolean' },
    machine: { type: 'string' },
    remoteRoot: { type: 'string' },
    endpoint: { type: 'string' },
    files: { type: 'integer' },
    bytes: { type: 'integer' },
    uploaded: { type: 'integer' },
    downloaded: { type: 'integer' },
    unchanged: { type: 'integer' },
    conflictCount: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          files: { type: 'integer' },
          uploaded: { type: 'integer' },
          downloaded: { type: 'integer' },
          conflicts: { type: 'integer' },
          missing: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['key', 'title', 'files', 'uploaded', 'missing', 'error'],
      },
    },
    oversized: { type: 'array', items: { type: 'string' } },
    conflictFiles: { type: 'array', items: { type: 'string' } },
    routes: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    errors: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'mode', 'dryRun', 'machine', 'remoteRoot', 'endpoint', 'files', 'bytes',
    'uploaded', 'downloaded', 'unchanged', 'conflictCount', 'items', 'oversized',
    'conflictFiles', 'routes', 'warnings', 'errors', 'notes'],
}

/** Build a client for the configured destination, or `null` when no URL is set. */
function makeClient(config) {
  const url = String(config?.url ?? '').trim()
  if (url === '') return null
  return new WebdavClient({
    url,
    username: String(config?.username ?? ''),
    password: String(config?.password ?? ''),
  })
}

/** A placeholder client so a local plan can report a destination without a URL. */
function offlineClient(config) {
  const refuse = async () => { throw new WebdavError('尚未配置 WebDAV 地址，无法上传。') }
  return {
    origin: '(未配置 WebDAV 地址)',
    insecure: false,
    remoteDir: String(config?.remoteDir ?? 'dsh-sync'),
    probe: refuse,
    put: refuse,
    getText: async () => null,
  }
}

/** Compress a full report into the fields a caller actually needs. */
function summarize(report) {
  return {
    ok: report.ok,
    mode: report.mode,
    dryRun: report.dryRun,
    machine: report.machine,
    remoteRoot: report.remoteRoot,
    endpoint: report.endpoint,
    files: report.totals.files,
    bytes: report.totals.bytes,
    uploaded: report.totals.uploaded,
    downloaded: report.totals.downloaded,
    unchanged: report.totals.unchanged,
    conflictCount: report.totals.conflicts,
    items: report.items.map(one => ({
      key: one.key,
      title: one.title,
      files: one.files,
      uploaded: one.uploaded,
      downloaded: one.downloaded,
      conflicts: one.conflicts,
      missing: one.missing.length,
      error: one.error ?? '',
    })),
    oversized: report.oversized.map(one => one.abs),
    conflictFiles: report.conflicts.map(one => one.resolution),
    // Only reported when something is wrong; a healthy registration stays quiet.
    routes: routeState.connection === 'present'
      && routeState.register === 'callable'
      && routeState.errors.length === 0
      && routeState.registered.length === 4
      ? ''
      : `connection=${routeState.connection} register=${routeState.register} `
        + `ok=${routeState.registered.length}/3`
        + (routeState.errors.length > 0 ? ` 错误：${routeState.errors.join(' | ')}` : ''),
    warnings: report.warnings,
    errors: report.errors,
    notes: report.notes,
  }
}

/** Render a summary as the text the model reads. */
function renderSummary(value) {
  const verb = value.dryRun ? '预演' : '完成'
  const lines = [
    `${verb}（${value.mode}）：${value.files} 个文件 / ${formatBytes(value.bytes)}`
    + `，上传 ${value.uploaded}、下载 ${value.downloaded}、未变 ${value.unchanged}`
    + (value.conflictCount > 0 ? `、冲突 ${value.conflictCount}` : '')
    + (value.remoteRoot ? ` → ${value.remoteRoot}` : ''),
  ]
  for (const one of value.items) {
    if (one.files === 0 && one.missing === 0 && one.conflicts === 0) continue
    const parts = []
    if (one.uploaded > 0) parts.push(`上传 ${one.uploaded}`)
    if (one.downloaded > 0) parts.push(`下载 ${one.downloaded}`)
    if (one.conflicts > 0) parts.push(`冲突 ${one.conflicts}`)
    if (parts.length === 0) parts.push(`${one.files} 个文件无变化`)
    const missing = one.missing > 0 ? `，${one.missing} 个来源不存在` : ''
    const suffix = one.error ? `  错误：${one.error}` : ''
    lines.push(`- ${one.title}: ${parts.join('，')}${missing}${suffix}`)
  }
  for (const artifact of value.conflictFiles.slice(0, 10)) lines.push(`冲突副本：${artifact}`)
  if (value.oversized.length > 0) {
    lines.push(`跳过超大文件 ${value.oversized.length} 个：${value.oversized.slice(0, 5).join('、')}`)
  }
  if (value.routes) lines.push(`接口：${value.routes}`)
  for (const note of value.notes) lines.push(`说明：${note}`)
  for (const warning of value.warnings) lines.push(`注意：${warning}`)
  for (const error of value.errors) lines.push(`失败：${error}`)
  return lines.join('\n')
}

/** Reject argument shapes the model got wrong, before any filesystem work starts. */
function validateArgs(args) {
  const source = args ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('nas_sync expects an object argument')
  }
  if (!['plan', 'run'].includes(source.action)) {
    throw new Error('nas_sync action must be "plan" or "run"')
  }
  if (source.items !== undefined && !Array.isArray(source.items)) {
    throw new Error('nas_sync items must be an array of scope keys')
  }
  if (source.dryRun !== undefined && typeof source.dryRun !== 'boolean') {
    throw new Error('nas_sync dryRun must be a boolean')
  }
  if (source.mode !== undefined && !['push', 'pull', 'two-way'].includes(source.mode)) {
    throw new Error('nas_sync mode must be "push", "pull", or "two-way"')
  }
  const known = new Set(ITEMS.map(item => item.key))
  const unknown = (source.items ?? []).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`unknown scope keys: ${unknown.join(', ')}; valid keys are ${[...known].join(', ')}`)
  }
}

/** Base path of the endpoints the settings page calls. */
const API_PREFIX = '/api/dsh-nas-sync'

/** What the last activation managed to register, surfaced through the tool. */
const routeState = { connection: 'unknown', register: 'unknown', registered: [], errors: [] }

/** Config keys the settings page may write. */
const EDITABLE = ['url', 'username', 'password', 'remoteDir', 'pullFrom',
  'overwrite', 'conflict', 'dryRun', 'maxFileMB', 'machineName']

/** Answer with JSON and no caching. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a JSON body, tolerating an empty one. */
async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

/** Keep only the fields the page is allowed to change, and coerce numeric ones. */
function pickEditable(source) {
  const patch = {}
  for (const key of EDITABLE) {
    if (source?.[key] === undefined) continue
    patch[key] = key === 'maxFileMB' || key === 'dryRun' ? source[key] : String(source[key])
  }
  if (patch.maxFileMB !== undefined) {
    const value = Number(patch.maxFileMB)
    if (!Number.isFinite(value) || value <= 0) throw new Error('maxFileMB 必须是正数')
    patch.maxFileMB = value
  }
  if (patch.overwrite !== undefined && !['missing', 'newer', 'always'].includes(patch.overwrite)) {
    throw new Error('overwrite 必须是 missing、newer 或 always')
  }
  if (patch.conflict !== undefined && !['both', 'newer', 'local', 'remote'].includes(patch.conflict)) {
    throw new Error('conflict 必须是 both、newer、local 或 remote')
  }
  if (patch.machineName !== undefined && String(patch.machineName).trim() !== '') {
    if (!MACHINE_NAME_PATTERN.test(String(patch.machineName).trim())) {
      throw new Error('设备名称只能用英文字母、数字、点、下划线、短横线，且需以字母或数字开头（最多 63 字符）')
    }
    patch.machineName = String(patch.machineName).trim()
  }
  return patch
}

/** Every configurable row key: standalone scopes plus grouped rows. */
const ROW_KEYS = ITEMS.map(item => item.key)

/** Merge per-scope participation switches, rejecting unknown keys. */
function pickEnabled(source) {
  if (source === undefined) return undefined
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('enabled 必须是对象')
  }
  const known = new Set(ROW_KEYS)
  const patch = {}
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) throw new Error(`未知的同步项：${key}`)
    if (typeof value !== 'boolean') throw new Error(`同步项 ${key} 的开关必须是布尔值`)
    patch[key] = value
  }
  return patch
}

/** Cap how many extra paths one configuration may carry. */
const MAX_EXTRA_DIRS = 50

/** Merge one user-specified path list, rejecting junk entries. */
function pickPathList(source, label) {
  if (source === undefined) return undefined
  if (!Array.isArray(source)) throw new Error(`${label} 必须是数组`)
  if (source.length > MAX_EXTRA_DIRS) throw new Error(`最多 ${MAX_EXTRA_DIRS} 个目录`)
  const seen = new Set()
  const list = []
  for (const value of source) {
    if (typeof value !== 'string') throw new Error('每个目录都必须是非空字符串')
    const text = value.trim()
    if (text === '') continue
    if (seen.has(text)) continue
    seen.add(text)
    list.push(text)
  }
  return list
}

/** Merge the extra-directory list, accepting the older bare-string form too. */
function pickExtraDirs(source) {
  if (source === undefined) return undefined
  if (!Array.isArray(source)) throw new Error('extraDirs 必须是数组')
  if (source.length > MAX_EXTRA_DIRS) throw new Error(`最多 ${MAX_EXTRA_DIRS} 个目录`)
  const seen = new Set()
  const list = []
  for (const raw of source) {
    const path = typeof raw === 'string' ? raw : String(raw?.path ?? '')
    const remoteRaw = typeof raw === 'string' ? '' : String(raw?.remote ?? '')
    const text = path.trim()
    if (text === '') continue
    const remote = remoteRaw.trim().replace(/^\/+|\/+$/g, '')
    // A remote target is joined to the WebDAV root, so it must not climb out of it.
    if (remote !== '' && (remote.split('/').some(part => part === '..' || part === '.') || /^[a-z]+:/i.test(remote))) {
      throw new Error(`远端路径不合法：${remoteRaw}`)
    }
    const key = `${text}\u0000${remote}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ path: text, remote })
  }
  return list
}

/** Merge the memory-directory list. */
const pickMemoryDirs = source => pickPathList(source, 'memoryDirs')

/** Merge per-scope directions, rejecting unknown keys and impossible directions. */
function pickItems(source) {
  if (source === undefined) return undefined
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('items 必须是对象')
  }
  const byKey = new Map(ITEMS.map(item => [item.key, item]))
  const patch = {}
  for (const [key, value] of Object.entries(source)) {
    const item = byKey.get(key)
    if (item === undefined) throw new Error(`未知的同步项：${key}`)
    if (value !== true && value !== false && !DIRECTIONS.includes(value)) {
      throw new Error(`同步项 ${key} 的方向必须是 ${DIRECTIONS.join(' / ')}`)
    }
    const direction = value === true ? 'push' : value === false ? 'off' : value
    const allowed = allowedDirections(item)
    if (!allowed.includes(direction)) {
      throw new Error(`${item.zh} 不支持 ${direction}（可选 ${allowed.join(' / ')}）`)
    }
    patch[key] = direction
  }
  return patch
}

/**
 * Register the sync tool against the live Config.
 * @param ctx - Host context.
 * @param config - the validated Config value.
 */
export function apply(ctx, config) {
  const settings = ctx.get('settings')
  if (settings !== undefined) {
    ctx.effect(() => {
      try {
        return settings.configure({ auto: true })
      } catch {
        // A policy registered by another layer is fine: the page still renders.
        return () => {}
      }
    })
  }

  ctx.tools.register({
    name: 'nas_sync',
    description: 'Sync selected DeepSeek Harness content with the configured WebDAV collection. '
      + 'Direction follows the plugin settings: push uploads into this machine slot, '
      + 'pull downloads for bootstrapping a new machine, two-way reconciles a shared tree with conflict copies. '
      + 'Use action "plan" to preview scope and size without writing, and "run" to transfer only changed files. '
      + 'Does nothing until a WebDAV URL is configured.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    async execute(args) {
      validateArgs(args)
      const only = Array.isArray(args.items) ? args.items : []
      const wantedDryRun = args.action === 'plan' || args.dryRun === true
      const live = readConfig(config)
      const client = makeClient(live) ?? offlineClient(live)
      const report = await run(live, ctx, client, { dryRun: wantedDryRun, only, mode: args.mode })
      return summarize(report)
    },
  })

  registerRoutes(ctx, config)
}

/**
 * Serve the endpoints the settings page calls.
 *
 * The page reads status and writes Config through these routes, so it needs no
 * generated Remote namespace.
 * @param ctx - Host context.
 * @param config - the volatile Config value.
 */
function registerRoutes(ctx, config) {
  routeState.connection = ctx.get('connection') === undefined ? 'missing' : 'present'
  routeState.register = typeof ctx.get('connection')?.fetch?.register === 'function' ? 'callable' : 'missing'
  routeState.registered = []
  routeState.errors = []

  const connection = ctx.get('connection')
  if (connection?.fetch?.register === undefined) return

  const routes = [
    {
      path: `${API_PREFIX}/overview`,
      methods: ['GET', 'HEAD'],
      fetch: async () => {
        try {
          // Configuration only: no disk walk and no network, so the page paints at once.
          return json(await describeScopes(readConfig(config)))
        } catch (error) {
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      },
    },
    {
      path: `${API_PREFIX}/status`,
      methods: ['GET', 'HEAD'],
      fetch: async (request) => {
        const live = readConfig(config)
        const client = makeClient(live)
        const params = new URL(request.url).searchParams
        try {
          const status = await buildStatus(live, ctx, client, {
            compare: params.get('compare') !== '0',
            fresh: params.get('fresh') === '1',
          })
          return json(status)
        } catch (error) {
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      },
    },
    {
      path: `${API_PREFIX}/run`,
      methods: ['POST'],
      fetch: async (request) => {
        const body = (await readJson(request)) ?? {}
        const live = readConfig(config)
        const client = makeClient(live) ?? offlineClient(live)
        try {
          const report = await run(live, ctx, client, {
            dryRun: body.dryRun !== false,
            only: Array.isArray(body.items) ? body.items : [],
            mode: typeof body.mode === 'string' ? body.mode : undefined,
          })
          // A run changed the remote, so cached listings are stale.
          invalidateRemoteCache()
          const summary = summarize(report)
          const text = renderSummary(summary)
          // A run that failed is reported as a failed call, so the page shows the
          // reason instead of leaving the user with a silent no-op.
          return json(report.ok
            ? { ok: true, summary, text }
            : { ok: false, error: text, summary, text })
        } catch (error) {
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      },
    },
    {
      path: `${API_PREFIX}/config`,
      methods: ['POST'],
      fetch: async (request) => {
        const body = await readJson(request)
        if (body === null) return json({ ok: false, error: '请求体必须是 JSON' }, 400)
        try {
          const settings = pickEditable(body.settings ?? {})
          const items = pickItems(body.items)
          const enabled = pickEnabled(body.enabled)
          const extraDirs = pickExtraDirs(body.extraDirs)
          const memoryDirs = pickMemoryDirs(body.memoryDirs)
          const entry = ctx.fiber?.entry
          const editor = ctx.get('configEditor')
          if (entry === undefined || editor === undefined) {
            throw new Error('当前 profile 无法保存配置')
          }
          await editor.edit(entry, current => {
            const next = { ...current, ...settings }
            if (items !== undefined) next.items = { ...(current?.items ?? {}), ...items }
            if (enabled !== undefined) next.enabled = { ...(current?.enabled ?? {}), ...enabled }
            if (extraDirs !== undefined) next.extraDirs = extraDirs
            if (memoryDirs !== undefined) next.memoryDirs = memoryDirs
            return next
          })
          return json({ ok: true })
        } catch (error) {
          return json({ ok: false, error: String(error?.message ?? error) }, 400)
        }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(connection.fetch.register({
          path: route.path,
          methods: route.methods,
          requestBody: 'buffered',
          fetch: route.fetch,
        }))
        routeState.registered.push(route.path)
      } catch (error) {
        routeState.errors.push(`${route.path}: ${String(error?.message ?? error)}`)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A route already gone is not an error during teardown.
        }
      }
    }
  })
}
