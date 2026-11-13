/**
 * Offline checks for the sync engine, run with plain `node` and no DSH.
 *
 * The whole run is sandboxed: DSH_HOME, DSH_AGENTS_HOME, and DSH_PROFILE_DIR are
 * repointed at a temporary tree before any engine call, so a non-dry pass can
 * never touch the real profile. This matters because `pull` and two-way sync
 * write to paths derived from those variables.
 *
 *   node test/plan-check.mjs
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Build a throwaway DSH tree and point the engine at it. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'nas-sync-test-'))
  const home = join(root, 'dsh')
  const agents = join(root, 'agents')
  const profile = join(home, 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await mkdir(join(home, 'sessions', '--proj--'), { recursive: true })
  await mkdir(join(home, 'attachments'), { recursive: true })
  await mkdir(join(home, 'storages'), { recursive: true })
  await mkdir(join(agents, 'skills', 'demo-skill'), { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml'), '# sandbox patch\n- id: demo\n')
  await writeFile(join(profile, 'package.json'), '{"name":"dsh-profile-desktop"}\n')
  await writeFile(join(home, 'desktop-preferences.json'), '{"locale":"zh"}\n')
  await writeFile(join(home, 'sessions', '--proj--', 'session-a.json'), '{"events":[]}\n')
  await writeFile(join(home, 'attachments', 'img.bin'), 'BINARY')
  await writeFile(join(home, 'storages', 'workspace.json'), '{"unit":{"name":"workspace"}}\n')
  await writeFile(join(agents, 'skills', 'demo-skill', 'SKILL.md'), '# demo\n')
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = agents
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'
  return { root, home, agents, profile }
}

const sandboxPaths = await sandbox()
console.log('sandbox:', sandboxPaths.root)

const { decide, PUSH, PULL, NONE, CONFLICT } = await import('../lib/merge.js')
const { plan, push, pull, twoWay, formatBytes } = await import('../lib/sync.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`)
}

console.log('\n=== decision table ===')
check('local only, no base -> push', decide({ local: 'a' }).action, PUSH)
check('remote only, no base -> pull', decide({ remote: 'a' }).action, PULL)
check('identical -> none', decide({ base: 'a', local: 'a', remote: 'a' }).action, NONE)
check('local moved -> push', decide({ base: 'a', local: 'b', remote: 'a' }).action, PUSH)
check('remote moved -> pull', decide({ base: 'a', local: 'a', remote: 'b' }).action, PULL)
check('both moved -> conflict', decide({ base: 'a', local: 'b', remote: 'c' }).action, CONFLICT)
check('no base, differs -> conflict', decide({ local: 'b', remote: 'c' }).action, CONFLICT)
check('policy local wins', decide({ base: 'a', local: 'b', remote: 'c' }, 'local').action, PUSH)
check('policy remote wins', decide({ base: 'a', local: 'b', remote: 'c' }, 'remote').action, PULL)
check('policy newer, local newer', decide({ base: 'a', local: 'b', remote: 'c', localMtime: 2000, remoteMtime: 1000 }, 'newer').action, PUSH)
check('local deleted -> keep remote copy', decide({ base: 'a', local: undefined, remote: 'a' }).action, 'keep-remote')
check('remote deleted -> keep local copy', decide({ base: 'a', local: 'a', remote: undefined }).action, 'keep-local')

/** Minimal in-memory WebDAV server. */
function memoryServer() {
  const files = new Map()
  return {
    files,
    origin: '(memory)',
    insecure: false,
    async probe() { return 'memory' },
    async put(rel, content) { files.set(rel, Buffer.from(content)) },
    async getText(rel) { const b = files.get(rel); return b === undefined ? null : b.toString('utf8') },
    async getBytes(rel) { const b = files.get(rel); return b === undefined ? null : b },
    async list(rel) {
      const prefix = rel === '' ? '' : `${rel}/`
      const seen = new Map()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const [head, ...tail] = rest.split('/')
        if (tail.length === 0) seen.set(head, { name: head, directory: false, size: files.get(key).length, lastModified: null })
        else if (!seen.has(head)) seen.set(head, { name: head, directory: true, size: null, lastModified: null })
      }
      return [...seen.values()]
    },
    async walk(rel) {
      const out = []
      const queue = [{ dir: '', prefix: '' }]
      while (queue.length > 0) {
        const { dir, prefix } = queue.shift()
        for (const child of await this.list(dir === '' ? rel : `${rel}/${dir}`)) {
          const childPrefix = prefix === '' ? child.name : `${prefix}/${child.name}`
          const childDir = dir === '' ? child.name : `${dir}/${child.name}`
          if (child.directory) queue.push({ dir: childDir, prefix: childPrefix })
          else out.push({ path: childPrefix, size: child.size, lastModified: child.lastModified })
        }
      }
      return out
    },
  }
}

const ctx = { get: () => undefined }
const config = {
  url: '', remoteDir: 'test-sync', maxFileMB: 200, conflict: 'both', overwrite: 'missing', pullFrom: '',
  items: {
    credentials: false, logs: false, modelConfig: false, mcpServers: false,
    presets: false, memory: false, recovery: false, providerState: false, pluginState: false,
  },
}

console.log('\n=== local inventory (sandbox) ===')
const local = await plan(config, ctx)
console.log(`machine ${local.machine}: ${local.files} files, ${formatBytes(local.bytes)}`)
check('finds sandbox patch', local.items.find(i => i.item.key === 'baseConfig').entries.length, 2)
check('finds sandbox skill', local.items.find(i => i.item.key === 'skills').entries.length, 1)
check('never reads the real home', local.env.home, sandboxPaths.home)

console.log('\n=== two-way first pass (everything is new) ===')
const server = memoryServer()
const first = await twoWay(config, ctx, server)
console.log(`uploaded ${first.totals.uploaded}, downloaded ${first.totals.downloaded}, conflicts ${first.totals.conflicts}`)
check('first pass uploads', first.totals.uploaded > 0, true)
check('first pass has no conflict', first.totals.conflicts, 0)

console.log('\n=== two-way second pass (idempotent) ===')
const second = await twoWay(config, ctx, server)
check('no re-upload', second.totals.uploaded, 0)
check('nothing downloaded', second.totals.downloaded, 0)

console.log('\n=== remote edit is pulled ===')
const target = [...server.files.keys()].find(k => k.endsWith('/baseConfig/dsh/profiles/desktop/cordis.patch.yml'))
check('found remote target', typeof target, 'string')
server.files.set(target, Buffer.from('# edited elsewhere\n'))
const third = await twoWay(config, ctx, server)
check('remote edit pulled', third.totals.downloaded, 1)

console.log('\n=== both sides edited -> conflict, both copies kept ===')
server.files.set(target, Buffer.from('# edited elsewhere v2\n'))
await writeFile(join(sandboxPaths.profile, 'cordis.patch.yml'), '# edited here v2\n')
const fourth = await twoWay(config, ctx, server)
check('one conflict', fourth.totals.conflicts, 1)
check('conflict artifact uploaded', [...server.files.keys()].some(k => k.includes('.conflict-')), true)
const { readFile } = await import('node:fs/promises')
check('local took the remote copy', (await readFile(join(sandboxPaths.profile, 'cordis.patch.yml'), 'utf8')).trim(), '# edited elsewhere v2')

console.log('\n=== pull honours overwrite=missing ===')
const boot = await pull(config, ctx, server, { dryRun: true })
check('pull sees remote files', boot.totals.files > 0, true)
check('existing files skipped', boot.totals.downloaded, 0)

console.log('\n=== pull overwrite=always would rewrite ===')
const boot2 = await pull({ ...config, overwrite: 'always' }, ctx, server, { dryRun: true })
check('dry run reports rewrites', boot2.totals.downloaded > 0, true)

console.log('\n=== push targets the machine slot ===')
const pushed = await push(config, ctx, server, { dryRun: true })
check('machine slot path', pushed.remoteRoot.includes('/machines/'), true)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
