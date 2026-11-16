/** Explicit, confirmed one-shot restore. Never changes scheduled directions. */
import { lstat, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ITEMS, MACHINE_NAME_PATTERN, environment, resolveFromTag } from './items.js'
import { isConflictArtifact } from './merge.js'

const baseOf = config => String(config.remoteDir || 'dsh-sync').replace(/^\/+|\/+$/g, '')
const safeRel = value => typeof value === 'string' && value !== '' && !value.startsWith('/')
  && !/[\\\0]/.test(value) && value.split('/').every(x => x !== '' && x !== '.' && x !== '..')
const inside = (root, file) => { const r = relative(resolve(root), resolve(file)); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep)) }

export async function listRestoreSources(config, client) {
  if (!client) throw new Error('请先保存 WebDAV 连接配置。')
  const base = baseOf(config)
  const roots = await client.list(base)
  const sources = []
  if (roots.some(x => x.directory && x.name === 'machines')) {
    const devices = await client.list(`${base}/machines`)
    for (const device of devices) {
      if (device.directory && MACHINE_NAME_PATTERN.test(device.name)) sources.push({ id: device.name, label: `${device.name} 的设备备份` })
    }
  }
  sources.sort((a, b) => a.id.localeCompare(b.id))
  if (roots.some(x => x.directory && x.name === 'shared')) sources.push({ id: '', label: '双向共享区' })
  return { sources }
}

async function assertNoSymlink(root, file) {
  if (!inside(root, file)) throw new Error('还原目标越出所选目录。')
  const parts = relative(root, file).split(sep).filter(Boolean)
  let path = root
  for (const part of [null, ...parts]) {
    if (part !== null) path = join(path, part)
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('还原目标含符号链接，已拒绝覆盖。') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

export async function restoreItem(config, client, body) {
  // Validate confirmation on the Host too, before any remote or local operation.
  if (body?.confirmed !== true) throw new Error('请先确认远端内容将覆盖本地文件。')
  const item = ITEMS.find(x => x.key === body.item)
  if (!item) throw new Error('未知同步内容项。')
  if (item.generated) throw new Error('此项为脱敏导出快照，不能直接写回；请通过基础配置备份恢复或手动导入。')
  if (typeof body.source !== 'string' || (body.source !== '' && !MACHINE_NAME_PATTERN.test(body.source))) throw new Error('请选择有效的备份来源。')
  if (!client) throw new Error('请先保存 WebDAV 连接配置。')
  const available = await listRestoreSources(config, client)
  if (!available.sources.some(x => x.id === body.source)) throw new Error('所选备份来源已不存在，请重新选择。')
  const env = environment()
  const source = `${baseOf(config)}/${body.source === '' ? 'shared' : `machines/${body.source}`}`
  const paths = item.paths ? await item.paths(env, config) : {}
  const scopes = item.scopes ? await item.scopes(env, config) : []
  const files = (paths.files || []).map(x => resolve(x))
  const trees = [...(paths.trees || []), ...scopes.map(x => x.abs)].map(x => resolve(x))
  const mappings = []
  const budget = { files: 0, maxFiles: 50000, strict: true }
  const remoteFiles = await client.walk(`${source}/${item.key}`, budget)
  for (const remote of remoteFiles) {
    if (!safeRel(remote.path)) throw new Error('备份包含不安全路径，已停止还原。')
    if (isConflictArtifact(remote.path)) continue
    const [tag, ...parts] = remote.path.split('/')
    if (!['dsh', 'agents', 'home', 'abs'].includes(tag) || parts.length === 0) throw new Error('备份包含无效路径，已停止还原。')
    let local = resolveFromTag(env, tag, parts.join('/'))
    // Profile backup belongs to the receiving profile, not the sender's profile name.
    if (tag === 'dsh' && /^profiles\/[^/]+\//.test(parts.join('/'))) local = join(env.profileDir, ...parts.slice(2))
    const root = files.includes(resolve(local)) ? dirname(local) : trees.find(tree => inside(tree, local))
    if (!root) throw new Error('备份包含不属于当前内容项的路径；请先配置正确的本地目录。')
    mappings.push({ remote: `${source}/${item.key}/${remote.path}`, local, root, size: remote.size })
  }
  // User-selected direct remote directories have no root tags; map to their saved local directory only.
  for (const scope of scopes.filter(x => x.remote)) {
    const direct = await client.walk(scope.remote, budget)
    let isFile = false
    try { isFile = (await lstat(scope.abs)).isFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const remote of direct) {
      if (!safeRel(remote.path)) throw new Error('备份包含不安全路径，已停止还原。')
      if (isConflictArtifact(remote.path)) continue
      if (isFile && remote.path !== basename(scope.abs)) continue
      mappings.push({ remote: `${scope.remote}/${remote.path}`, local: isFile ? scope.abs : join(scope.abs, remote.path), root: isFile ? dirname(scope.abs) : scope.abs, size: remote.size })
    }
  }
  if (budget.exhausted) throw new Error('备份文件数量超过安全上限，请拆分目录后重试。')
  if (!mappings.length) throw new Error('所选来源没有可还原的文件，本地未改动。')
  const maxBytes = Number(config.maxFileMB || 200) * 1024 * 1024
  // Preflight all destinations before the first write.
  for (const entry of mappings) {
    if (entry.size > maxBytes) throw new Error('备份文件超过单文件大小上限，本地未改动。')
    await assertNoSymlink(entry.root, entry.local)
  }
  let downloaded = 0
  try {
    for (const entry of mappings) {
      const bytes = await client.getBytes(entry.remote)
      if (bytes === null) throw new Error('备份文件已消失，请重新选择来源。')
      if (bytes.byteLength > maxBytes) throw new Error('备份文件超过单文件大小上限。')
      await mkdir(dirname(entry.local), { recursive: true })
      await assertNoSymlink(entry.root, entry.local)
      const temp = `${entry.local}.restore-${randomUUID()}`
      try {
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temp, entry.local)
      } finally { await unlink(temp).catch(() => {}) }
      downloaded += 1
    }
  } catch (error) { throw new Error(`还原中断，已覆盖 ${downloaded} 个文件：${error.message}`) }
  const caution = ['baseConfig', 'pluginInventory', 'credentials'].includes(item.key) ? ' 配置文件已写回，可能需要重启 DSH；插件清单还原后需重新安装依赖。' : ''
  return { ok: true, downloaded, text: `已从「${body.source || '双向共享区'}」还原${item.zh}：覆盖或新增 ${downloaded} 个文件；本地其他文件未删除，同步方向未改变。${caution}` }
}
