/** Offline route lifecycle regression: node test/routes-check.mjs.
 * Evaluates the production registration function with explicit dependency stubs;
 * no live profile, network, configuration edits or sync operations are used.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const inject = Function(`${source.match(/export const inject = (\[[^\]]+\])/)[0].replace('export ', '')}; return inject`)()
assert.ok(inject.includes('connection'), 'Cordis must defer apply until connection is available')
assert.ok(inject.includes('tools'))
const routeState = { registered: [], errors: [] }
const registerRoutes = Function('routeState', 'API_PREFIX', 'json', 'readConfig', 'describeScopes',
  `${source.slice(source.indexOf('function registerRoutes('))}; return registerRoutes`)(
  routeState, '/api/dsh-nas-sync',
  (value, status = 200) => Response.json(value, { status }),
  value => value,
  async config => ({ rows: [], machine: config.machineName }),
)
const paths = ['restore-sources', 'restore', 'overview', 'status', 'run', 'config'].map(path => `/api/dsh-nas-sync/${path}`)
function connection() {
  const routes = new Map()
  let removed = 0
  return {
    routes,
    get removed() { return removed },
    fetch: {
      register(route) {
        assert.ok(!routes.has(route.path), 'no duplicate exact routes')
        routes.set(route.path, route)
        return async () => {
          await Promise.resolve()
          routes.delete(route.path)
          removed++
        }
      },
    },
  }
}
function mount(service) {
  let cleanup
  const ctx = {
    connection: service,
    get: key => key === 'connection' ? service : undefined,
    effect: callback => { cleanup = callback() },
  }
  registerRoutes(ctx, { machineName: 'test-device' })
  return () => cleanup()
}

assert.throws(() => mount(undefined), /requires connection.fetch.register/,
  'missing connection must not silently leave the panel with 404')
const first = connection()
const dispose = mount(first)
assert.deepEqual([...first.routes.keys()], paths)
assert.equal(routeState.errors.length, 0)
assert.equal(routeState.registered.length, 6)
const overview = first.routes.get(paths[2])
assert.deepEqual(overview.methods, ['GET', 'HEAD'])
assert.equal(overview.requestBody, 'buffered')
const response = await overview.fetch(new Request(`http://localhost${paths[0]}`))
assert.equal(response.status, 200)
assert.deepEqual(await response.json(), { rows: [], machine: 'test-device' })
await dispose()
assert.equal(first.routes.size, 0, 'dispose awaits asynchronous removal of every route')
assert.equal(first.removed, 6)
const second = connection()
await mount(second)()
assert.equal(second.removed, 6, 'replacement connection can register and remove all six routes')
console.log('ALL ROUTE CHECKS PASSED (dependency, missing service, 6 routes, overview, async cleanup, replacement)')
