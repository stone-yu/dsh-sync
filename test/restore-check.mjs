import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-restore-test-'))
const saved = { ...process.env }
try {
  process.env.DSH_HOME = join(sandbox, 'dsh')
  process.env.DSH_PROFILE_DIR = join(sandbox, 'dsh', 'profiles', 'receiver')
  process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')
  const { listRestoreSources, restoreItem } = await import('../lib/restore.js')
  const { allowedDirections, ITEMS } = await import('../lib/items.js')
  for (const item of ITEMS) assert.ok(!allowedDirections(item).includes('pull'))
  const config = { remoteDir: 'backup', maxFileMB: 1, items: { baseConfig: 'off' } }
  const original = structuredClone(config)
  let contents = [{ path: 'dsh/profiles/sender/cordis.patch.yml', size: 6 }]
  const client = {
    list: async path => path === 'backup' ? [{ name: 'machines', directory: true }, { name: 'shared', directory: true }] : [{ name: 'sender', directory: true }, { name: '../evil', directory: true }, { name: 'not-a-device', directory: false }],
    walk: async () => contents,
    getBytes: async () => Buffer.from('REMOTE'),
  }
  const target = join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')
  await mkdir(process.env.DSH_PROFILE_DIR, { recursive: true })
  await writeFile(target, 'LOCAL')
  assert.deepEqual((await listRestoreSources(config, client)).sources.map(x => x.id), ['sender', ''])
  await assert.rejects(restoreItem(config, client, { item: 'baseConfig', source: 'sender' }), /确认/)
  assert.equal(await readFile(target, 'utf8'), 'LOCAL')
  const result = await restoreItem(config, client, { item: 'baseConfig', source: 'sender', confirmed: true })
  assert.equal(result.downloaded, 1)
  assert.equal(await readFile(target, 'utf8'), 'REMOTE')
  assert.deepEqual(config, original, 'one-shot restore must not alter saved direction/switch/source')
  await assert.rejects(restoreItem(config, client, { item: 'modelConfig', source: 'sender', confirmed: true }), /快照/)
  await assert.rejects(restoreItem(config, client, { item: 'baseConfig', source: '../evil', confirmed: true }), /来源/)
  contents = [{ path: 'dsh/not-this-scope.txt', size: 2 }]
  await assert.rejects(restoreItem(config, client, { item: 'baseConfig', source: 'sender', confirmed: true }), /不属于/)
  contents = []
  await assert.rejects(restoreItem(config, client, { item: 'baseConfig', source: 'sender', confirmed: true }), /没有可还原/)
  contents = [{ path: 'dsh/profiles/sender/cordis.patch.yml', size: 2e6 }]
  await assert.rejects(restoreItem(config, client, { item: 'baseConfig', source: 'sender', confirmed: true }), /大小上限/)
  const credentials = join(process.env.DSH_HOME, '.credentials.yaml')
  const outside = join(sandbox, 'outside'); await writeFile(outside, 'SAFE')
  await symlink(outside, credentials)
  contents = [{ path: 'dsh/.credentials.yaml', size: 6 }]
  await assert.rejects(restoreItem(config, client, { item: 'credentials', source: '', confirmed: true }), /符号链接/)
  assert.equal(await readFile(outside, 'utf8'), 'SAFE')
  contents = [{ path: 'dsh/../escape', size: 1 }]
  await assert.rejects(restoreItem(config, client, { item: 'baseConfig', source: 'sender', confirmed: true }), /不安全路径/)
  const { WebdavClient } = await import('../lib/webdav.js')
  await assert.rejects(WebdavClient.prototype.walk.call({ list: async () => { throw new Error('HTTP 403') } }, 'remote', { files: 0, maxFiles: 5, strict: true }), /403/)
  const customLocal = join(sandbox, 'custom')
  await mkdir(customLocal)
  await writeFile(join(customLocal, 'untouched.txt'), 'KEEP')
  const customClient = { ...client, walk: async path => path === 'public/output' ? [{ path: 'result.txt', size: 6 }] : [] }
  await restoreItem({ ...config, extraDirs: [{ path: customLocal, remote: 'public/output' }] }, customClient, { item: 'extraPaths', source: 'sender', confirmed: true })
  assert.equal(await readFile(join(customLocal, 'result.txt'), 'utf8'), 'REMOTE')
  assert.equal(await readFile(join(customLocal, 'untouched.txt'), 'utf8'), 'KEEP')
  console.log('ALL RESTORE CHECKS PASSED (directions, sources, confirmation, overwrite, off scope, profile mapping, immutable config, exports blocked, invalid source, path scope, empty, size, symlink)')
} finally {
  for (const key of ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_AGENTS_HOME']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  }
  await rm(sandbox, { recursive: true, force: true })
}
