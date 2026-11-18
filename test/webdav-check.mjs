import assert from 'node:assert/strict'
import { WebdavClient } from '../lib/webdav.js'
import { readFile } from 'node:fs/promises'
const originalFetch = globalThis.fetch
const calls = []
const response = (href, resource) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${resource}</D:resourcetype><D:getcontentlength>4</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
const collection = '<D:collection xmlns:D="DAV:"/>'
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(init.method, 'PROPFIND')
    const path = new URL(url).pathname
    calls.push(path)
    const children = path === '/dav/root'
      ? response('/dav/root/folder/', collection) + response('/dav/root/top.txt', '')
      : response('/dav/root/folder/nested/', '<collection xmlns="DAV:"></collection>')
    const content = path === '/dav/root/folder/nested' ? response('/dav/root/folder/nested/leaf.txt', '') : children
    return new Response(`<D:multistatus xmlns:D="DAV:">${response(path+'/', collection)}${content}</D:multistatus>`, { status: 207 })
  }
  const client = new WebdavClient({ url: 'https://example.invalid/dav' })
  const top = await client.list('root')
  assert.equal(top.length, 2, 'self excluded')
  assert.equal(top[0].directory, true, 'namespace attribute on collection must not turn a folder into a file')
  assert.equal(top[1].directory, false)
  const files = await client.walk('root', { files: 0, maxFiles: 100, strict: true })
  assert.deepEqual(files.map(x => x.path).sort(), ['folder/nested/leaf.txt', 'top.txt'])
  assert.ok(calls.includes('/dav/root/folder/nested'), 'recursive directory traversal reaches leaf')
  const source = await readFile(new URL('../lib/status.js', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('async function cachedWalk('), source.indexOf('/** sha256'))
  const cache = new Map()
  const cachedWalk = Function('walkCache', 'WALK_TTL_MS', `${fn}; return cachedWalk`)(cache, 15000)
  await assert.rejects(cachedWalk({ origin: 'test', walk: async (_p, budget) => { assert.equal(budget.strict, true); throw new Error('HTTP 403') } }, 'root', {}, true), /403/)
  assert.equal(cache.size, 0, 'failed walks are not cached as small counts')
  await assert.rejects(cachedWalk({ origin: 'test', walk: async (_p, budget) => { budget.exhausted = true; return [] } }, 'root', {}, true), /统计上限/)
  assert.equal(cache.size, 0, 'truncated walks are not cached as exact counts')
  console.log('ALL WEBDAV CHECKS PASSED (namespaced attributes, default namespace, self exclusion, recursive file-only counts)')
} finally { globalThis.fetch = originalFetch }
