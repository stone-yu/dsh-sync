/**
 * The sync catalogue: one entry per selectable scope.
 *
 * Every entry resolves to ordinary filesystem paths, except `generated` entries,
 * which ask a live Host service for a machine-portable snapshot instead of
 * copying the raw configuration file (model routes, MCP rows, agent presets).
 *
 * @module @local/dsh-nas-sync/lib/items
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the directories this plugin reads from.
 * @returns absolute `home` (DSH_HOME), `agentsHome`, `profileName`, and `profileDir`.
 */
export function environment() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const agentsHome = process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), '.agents')
  const profileName = process.env.DSH_PROFILE?.trim() || 'desktop'
  const profileDir = process.env.DSH_PROFILE_DIR?.trim() || join(home, 'profiles', profileName)
  return { home, agentsHome, profileName, profileDir }
}

/** Allowed shape of a user-chosen device name: ASCII letters, digits, dot, dash, underscore. */
export const MACHINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/**
 * A stable, filesystem-safe identity for this machine's backup slot.
 *
 * A configured name wins over the derived one, because the name is what the
 * remote directory is called and the user is the only one who knows which
 * machine "macbook-office" actually is.
 * @param env - value from {@link environment}.
 * @param override - configured device name, or empty to derive one.
 * @returns the slot name used under `machines/`.
 */
export async function machineId(env, override) {
  const chosen = String(override ?? '').trim()
  if (chosen !== '') return chosen.toLowerCase()
  let install = ''
  try {
    install = (await readFile(join(env.home, '.anonymous-user-id'), 'utf8')).trim().slice(0, 12)
  } catch {
    install = ''
  }
  const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const host = slug(hostname()) || 'host'
  return install === '' ? host : `${host}-${slug(install)}`
}

/**
 * Resolve one user-typed path: expand a leading `~` and make it absolute.
 * @param value - the path as typed in the settings page.
 * @returns an absolute path.
 */
export function expandPath(value) {
  const text = String(value ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text.startsWith('/') ? text : join(homedir(), text)
}

/**
 * Turn user-typed paths into the trees and files a scope collects.
 *
 * A path that no longer exists is kept as a tree so the run report can list it
 * as a missing source instead of silently ignoring it. An explicit file already
 * covered by one of the trees is dropped, so nothing is collected twice.
 * @param typed - paths as typed in the settings page.
 * @returns `{ trees, files }` with absolute paths.
 */
async function classifyPaths(typed) {
  const trees = []
  const files = []
  const seen = new Set()
  const list = Array.isArray(typed) ? typed : []
  for (const entry of list) {
    const abs = expandPath(entry)
    if (abs === '' || seen.has(abs)) continue
    seen.add(abs)
    try {
      const info = await stat(abs)
      if (info.isDirectory()) trees.push(abs)
      else if (info.isFile()) files.push(abs)
    } catch {
      trees.push(abs)
    }
  }
  const covered = files.filter(file => !trees.some(tree => file === tree || file.startsWith(`${tree}/`)))
  return { trees, files: covered }
}

/** Directories under DSH_HOME that look like memory storage, discovered at run time. */
async function memoryRoots(env) {
  const found = []
  let entries = []
  try {
    entries = await readdir(env.home, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isDirectory() && /(^|[-_.])(mnemon|memory)/i.test(entry.name)) {
      found.push(join(env.home, entry.name))
    }
  }
  return found
}

/**
 * Keep only the descriptors whose profile entry id matches a pattern.
 *
 * Only `ns` and `value` are kept. `schema` carries `uid`/`refs` node ids that the
 * schema library assigns sequentially on every projection, so including it makes
 * the artifact differ on every call: its digest never matches the uploaded copy,
 * the item is re-uploaded forever, and its status never reads as synced.
 */
function matching(descriptors, pattern) {
  return descriptors
    .filter(descriptor => pattern.test(String(descriptor.ns ?? '')))
    .map(descriptor => ({ ns: descriptor.ns, value: descriptor.value }))
    .sort((left, right) => String(left.ns).localeCompare(String(right.ns)))
}

/**
 * The selectable scopes, in the order the settings page presents them.
 *
 * `kind` is `tree` for a directory walk, `files` for individual paths, and
 * `generated` for an artifact produced from a live Host service.
 */
export const ITEMS = [
  {
    key: 'baseConfig',
    en: 'Base configuration',
    zh: '基础配置',
    note: { en: 'Profile patch, entry list, desktop preferences and locale.', zh: 'Profile 补丁层、入口表、桌面偏好与语言。' },
    default: true,
    paths: env => ({
      files: [
        join(env.profileDir, 'cordis.patch.yml'),
        join(env.profileDir, 'cordis.yml'),
        join(env.home, 'desktop-preferences.json'),
        join(env.home, 'desktop-locale.json'),
      ],
    }),
  },
  {
    key: 'modelConfig',
    en: 'Model configuration',
    zh: '模型配置',
    note: { en: 'Provider routes and model lists, exported as portable JSON.', zh: 'Provider 路由与模型清单，导出为可移植 JSON。' },
    default: true,
    generated: async (_env, ctx) => {
      const settings = ctx?.get?.('settings')
      if (settings === undefined) return []
      const descriptors = settings.describe({ redactSecrets: true })
      return [{ name: 'model-routes.json', content: JSON.stringify(matching(descriptors, /^llm-|model|provider/i), null, 2) }]
    },
  },
  {
    key: 'mcpServers',
    en: 'MCP servers',
    zh: 'MCP 服务器',
    note: { en: 'Live MCP loader rows, exported as JSON.', zh: '已挂载的 MCP 装载行，导出为 JSON。' },
    default: true,
    generated: async (_env, ctx) => {
      const settings = ctx?.get?.('settings')
      if (settings === undefined) return []
      const descriptors = settings.describe({ redactSecrets: true })
      const rows = matching(descriptors, /mcp/i)
      return [{ name: 'mcp-servers.json', content: JSON.stringify(rows, null, 2) }]
    },
  },
  {
    key: 'pluginInventory',
    en: 'Installed plugins',
    zh: '已安装插件',
    note: { en: 'Bundle list, profile manifest and pnpm lockfile; restore reinstalls from these.', zh: 'Bundle 列表、profile 清单与 pnpm 锁文件；恢复时据重装。' },
    default: true,
    paths: env => ({
      files: [
        join(env.profileDir, 'package.json'),
        join(env.profileDir, 'pnpm-lock.yaml'),
        join(env.profileDir, 'pnpm-workspace.yaml'),
      ],
    }),
  },
  {
    key: 'skills',
    en: 'Skills',
    zh: '技能',
    note: { en: 'User skill library, its version lockfile, and any DSH-home skills.', zh: '用户技能库、版本锁文件，以及 DSH 主目录下的技能。' },
    default: true,
    paths: env => ({
      trees: [join(env.agentsHome, 'skills'), join(env.home, 'skills')],
      files: [join(env.agentsHome, '.skill-lock.json')],
    }),
  },
  {
    key: 'credentials',
    en: 'API keys and tokens',
    zh: 'API 密钥与令牌',
    note: {
      en: 'The .credentials.yaml file: account tokens, OAuth grants, and access keys.',
      zh: '即 .credentials.yaml，含账号令牌、OAuth 授权与访问密钥。',
    },
    default: false,
    risk: 'plaintext',
    paths: env => ({ files: [join(env.home, '.credentials.yaml')] }),
  },
  {
    key: 'memory',
    en: 'Memory',
    zh: '记忆',
    note: { en: 'Detected memory storage directories, plus any extra paths you list.', zh: '自动探测到的记忆存储目录，以及你额外填写的路径。' },
    default: true,
    paths: async (env, config) => {
      const typed = Array.isArray(config?.memoryDirs) ? config.memoryDirs : []
      if (typed.length > 0) return await classifyPaths(typed)
      // Nothing configured: fall back to any memory-looking directory under DSH_HOME.
      return { trees: await memoryRoots(env) }
    },
  },
  {
    key: 'extraPaths',
    en: 'Extra directories',
    zh: '其他文件目录',
    note: {
      en: 'Any directories or files you add yourself, such as project notes or exported results. Each path is resolved with ~ for your home directory.',
      zh: '自行添加的任意目录或文件，例如项目笔记、导出结果。路径支持 ~ 表示用户主目录，可在下面增删。',
    },
    default: false,
    // Each configured path may carry its own remote target, because this scope is
    // often public output that other tools read at a fixed location.
    scopes: (env, config) => {
      const configured = Array.isArray(config?.extraDirs) ? config.extraDirs : []
      const out = []
      const seen = new Set()
      for (const raw of configured) {
        const local = typeof raw === 'string' ? raw : String(raw?.path ?? '')
        const remote = typeof raw === 'string' ? '' : String(raw?.remote ?? '').trim().replace(/^\/+|\/+$/g, '')
        const abs = expandPath(local)
        if (abs === '' || seen.has(abs)) continue
        seen.add(abs)
        out.push({ abs, remote })
      }
      return out
    },
  },
]

/**
 * Scopes whose content is meaningfully shared between machines, so two-way sync
 * can compare a base, local, and remote copy. The rest are machine-local in
 * value even when they look portable: absolute paths, per-machine tokens, or
 * rollback points that only make sense on the machine that wrote them.
 */
export const TWO_WAY = new Set([
  'baseConfig', 'skills', 'credentials', 'memory', 'extraPaths',
])

/**
 * Scopes that may be pulled, but whose content embeds machine-specific state.
 * Restoring them on a new machine is sometimes what a bootstrap wants, so they
 * are allowed with a report note instead of being refused.
 */
export const PULL_CAVEAT = {
  pluginInventory: '清单里可能有 link:/file: 的本机绝对路径，恢复后需要手工改。',
  workspaceRegistry: '工作区登记含本机绝对路径，恢复后路径可能不适用。',
}

/** The tag that identifies which filesystem root a remote path came from. */
export function rootTagFor(env, abs) {
  if (abs.startsWith(env.home + '/')) return 'dsh'
  if (abs.startsWith(env.agentsHome + '/')) return 'agents'
  const home = homedir()
  if (home !== '' && abs.startsWith(home + '/')) return 'home'
  return 'abs'
}

/**
 * Rebuild an absolute local path from a remote path's root tag.
 * @param env - value from {@link environment}.
 * @param tag - `dsh`, `agents`, `home`, or `abs`.
 * @param rel - path below that root.
 */
export function resolveFromTag(env, tag, rel) {
  switch (tag) {
    case 'dsh': return join(env.home, rel)
    case 'agents': return join(env.agentsHome, rel)
    case 'home': return join(homedir(), rel)
    default: return join('/', rel)
  }
}

/** The four directions one scope can take. `off` keeps it out of every run. */
export const DIRECTIONS = ['off', 'push', 'pull', 'two-way']

/** The direction a scope takes when configuration says nothing about it. */
export function defaultDirection(item) {
  return item.default === true ? 'push' : 'off'
}

/**
 * Resolve one scope's direction from configuration.
 *
 * Older configurations stored booleans; `true` maps to `push` and `false` to
 * `off`, so an existing profile keeps working after the switch to directions.
 * @param config - plugin Config with `items.<key>` entries.
 * @param item - catalogue entry.
 */
export function directionOf(config, item) {
  const raw = config?.items?.[item.key]
  if (raw === undefined || raw === null) return defaultDirection(item)
  if (raw === true) return 'push'
  if (raw === false) return 'off'
  const value = String(raw)
  return DIRECTIONS.includes(value) ? value : defaultDirection(item)
}

/** A scope may only sync two ways when its content is shareable across machines. */
export function allowedDirections(item) {
  return TWO_WAY.has(item.key) ? DIRECTIONS : ['off', 'push', 'pull']
}
