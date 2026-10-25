import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

type PublicApi = typeof import('../../src/index')

const DIST_ENTRY = new URL('../../dist/index.js', import.meta.url)
const DIST_TYPES = new URL('../../dist/index.d.ts', import.meta.url)
const EXPECTED_EXPORTS = [
  'IdempotencyConfigError',
  'IdempotencyEngine',
  'IdempotencyError',
  'MemoryStore',
  'RedisStore',
  'StoreConflictError',
  'StoreUnavailableError',
  'SystemClock',
  'idempotency',
  'idempotencyEngineOptionsSchema',
  'idempotencyPluginOptionsSchema',
  'isIdempotencyStore',
]

const distBuilt = await Bun.file(DIST_ENTRY).exists()

const loadDist = async (): Promise<PublicApi> => import(DIST_ENTRY.href)

const charge = () =>
  new Request('http://localhost/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'smoke-1' },
    body: JSON.stringify({ amount: 100 }),
  })

describe.if(distBuilt)('built package', () => {
  test('exports exactly the public API', async () => {
    const api = await loadDist()
    expect(Object.keys(api).sort()).toEqual(EXPECTED_EXPORTS)
    expect(await Bun.file(DIST_TYPES).exists()).toBe(true)
  })

  test('replays a retried request in a tiny app', async () => {
    const { idempotency, MemoryStore } = await loadDist()
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ store: new MemoryStore(), required: true }))
      .post('/payments', ({ status }) => ((runs += 1), status(201, { id: runs })))
    const first = await app.handle(charge())
    const replay = await app.handle(charge())
    expect(runs).toBe(1)
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(await replay.json()).toEqual(await first.json())
  })

  test('fails loudly on a config typo', async () => {
    const { idempotency, IdempotencyConfigError } = await loadDist()
    expect(() => idempotency({ requried: true } as never)).toThrow(IdempotencyConfigError)
  })
})

test.skipIf(distBuilt)('dist smoke test skipped: dist/ is missing, run `bun run build` first', () => {})
