import { describe, expect, spyOn, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { IdempotencyEngine } from '../../src/engine/idempotency-engine'
import { StoreConflictError } from '../../src/errors'
import { KeyBuilder } from '../../src/keys/key-builder'
import { type IdempotencyOutcome, idempotency } from '../../src/plugin/idempotency-plugin'
import type { IdempotencyPluginOptions, IdempotencyRequestContext } from '../../src/plugin/plugin-schema'
import type { IdempotencyRejection } from '../../src/plugin/rejection-response'
import { ResponseCapture } from '../../src/plugin/response-capture'
import { MemoryStore } from '../../src/stores/memory-store'
import type { IdempotencyStore } from '../../src/stores/store'
import { ManualClock } from '../helpers/manual-clock'
import { ObservedStore } from '../helpers/observed-store'

const SECRET = 'redis://admin:hunter2@internal-host:6379'
const KEY = 'order-7f3c'

interface Sent {
  readonly method?: string
  readonly key?: string | null
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

const send = (path: string, { method = 'POST', key = KEY, body = { amount: 10 }, headers = {} }: Sent = {}) => {
  const keyHeader: Record<string, string> = key === null ? {} : { 'idempotency-key': key }
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...keyHeader, ...headers },
    body: method === 'GET' ? null : JSON.stringify(body),
  })
}

const createApp = (options: IdempotencyPluginOptions = {}) => {
  const runs: unknown[] = []
  const app = new Elysia()
    .use(idempotency({ clock: new ManualClock(), ...options }))
    .post('/payments', ({ body, idempotency: outcome, status }) => {
      runs.push(body)
      return status(201, { id: runs.length, outcome: outcome.status })
    })
    .get('/payments', ({ idempotency: outcome }) => {
      runs.push('get')
      return { outcome: outcome.status }
    })
  return { app, runs }
}

const failingStore = (error: unknown): IdempotencyStore => {
  const fail = async (): Promise<never> => {
    throw error
  }
  return { read: fail, update: fail, delete: fail }
}

const STACK_FRAME = /\bat .+:\d+:\d+/

const expectNoLeaks = (body: string) => {
  expect(body).not.toMatch(STACK_FRAME)
  expect(body).not.toMatch(/[0-9a-f]{64}/)
  expect(body).not.toContain(KEY)
  expect(body).not.toContain('hunter2')
  expect(body).not.toContain('internal-host')
  expect(body).not.toContain('stack')
}

describe('idempotency replay', () => {
  test('runs the handler once and replays the original response', async () => {
    const { app, runs } = createApp()
    const first = await app.handle(send('/payments'))
    const second = await app.handle(send('/payments'))
    expect(runs).toHaveLength(1)
    expect(first.status).toBe(201)
    expect(first.headers.get('idempotent-replayed')).toBeNull()
    expect(second.status).toBe(201)
    expect(second.headers.get('idempotent-replayed')).toBe('true')
    expect(second.headers.get('content-type')).toBe(first.headers.get('content-type'))
    expect(await second.text()).toBe('{"id":1,"outcome":"started"}')
  })

  test('accepts a quoted key as the same key', async () => {
    const { app, runs } = createApp()
    await app.handle(send('/payments', { key: 'abc' }))
    const replay = await app.handle(send('/payments', { key: '"abc"' }))
    expect(runs).toHaveLength(1)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
  })

  test('replays stored headers but never cookies, and sends the original cookie once', async () => {
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock(), excludeHeaders: ['X-Request-Id'] }))
      .post('/login', ({ set, cookie }) => {
        set.headers['x-account'] = 'acct_1'
        set.headers['x-request-id'] = crypto.randomUUID()
        cookie.session?.set({ value: 'secret-session', path: '/' })
        return 'ok'
      })
    const first = await app.handle(send('/login'))
    const replay = await app.handle(send('/login'))
    expect(first.headers.getSetCookie()).toEqual(['session=secret-session; Path=/'])
    expect(first.headers.get('x-request-id')).not.toBeNull()
    expect(replay.headers.get('x-account')).toBe('acct_1')
    expect(replay.headers.get('x-request-id')).toBeNull()
    expect(replay.headers.getSetCookie()).toEqual([])
    expect(await replay.text()).toBe('ok')
  })

  test('stores a status() error so a declined payment is not charged twice', async () => {
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock() }))
      .post('/charge', ({ status }) => ((runs += 1), status(402, { error: 'card declined' })))
    const first = await app.handle(send('/charge'))
    const replay = await app.handle(send('/charge'))
    expect(runs).toBe(1)
    expect([first.status, replay.status]).toEqual([402, 402])
    expect(await replay.json()).toEqual({ error: 'card declined' })
  })

  test('replays a body over maxBodyBytes with its status and an empty body', async () => {
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock(), maxBodyBytes: 16 }))
      .post('/report', () => ((runs += 1), 'x'.repeat(1_000)))
    const first = await app.handle(send('/report'))
    const replay = await app.handle(send('/report'))
    expect(await first.text()).toHaveLength(1_000)
    expect(runs).toBe(1)
    expect(replay.status).toBe(200)
    expect(await replay.text()).toBe('')
  })

  test('never runs a streaming handler twice', async () => {
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock() }))
      .post('/stream', async function* () {
        runs += 1
        yield 'a'
        yield 'b'
      })
    const first = await app.handle(send('/stream'))
    const replay = await app.handle(send('/stream'))
    expect(await first.text()).toBe('ab')
    expect(runs).toBe(1)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(await replay.text()).toBe('ab')
  })

  test('runs again once retention has passed', async () => {
    const clock = new ManualClock()
    const { app, runs } = createApp({ clock, retention: '1h' })
    await app.handle(send('/payments'))
    clock.advance(3_600_001)
    const again = await app.handle(send('/payments'))
    expect(runs).toHaveLength(2)
    expect(again.headers.get('idempotent-replayed')).toBeNull()
  })
})

describe('idempotency coverage of requests', () => {
  test('passes uncovered methods through untouched', async () => {
    const { app, runs } = createApp()
    const responses = [await app.handle(send('/payments', { method: 'GET' })), await app.handle(send('/payments', { method: 'GET' }))]
    expect(runs).toEqual(['get', 'get'])
    expect(await responses[1]?.json()).toEqual({ outcome: 'skipped' })
  })

  test('runs requests without a key every time when keys are optional', async () => {
    const { app, runs } = createApp()
    await app.handle(send('/payments', { key: null }))
    const second = await app.handle(send('/payments', { key: null }))
    expect(runs).toHaveLength(2)
    expect(await second.json()).toEqual({ id: 2, outcome: 'skipped' })
  })

  test('answers 400 for a missing key when keys are required', async () => {
    const { app, runs } = createApp({ required: true })
    const response = await app.handle(send('/payments', { key: null }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Idempotency-Key header is required' })
    expect(runs).toHaveLength(0)
  })

  test.each([
    ['too long', 'k'.repeat(256)],
    ['with spaces', 'two words'],
    ['with control characters', 'bad\u0001key'],
    ['with several values', 'one, two'],
    ['with a backslash', 'back\\slash'],
  ])('answers 400 for a key %s and never touches the store', async (_, key) => {
    const store = new ObservedStore()
    const { app, runs } = createApp({ store })
    const response = await app.handle(send('/payments', { key }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Idempotency-Key header is invalid' })
    expect(runs).toHaveLength(0)
    expect(store.writes).toEqual([])
  })

  test('reads the key from a custom header and covers custom methods', async () => {
    const runs: string[] = []
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock(), header: 'X-Request-Key', methods: ['put'] }))
      .put('/items', () => (runs.push('put'), 'saved'))
      .post('/items', () => (runs.push('post'), 'posted'))
    const headers = { 'x-request-key': 'k1' }
    await app.handle(send('/items', { method: 'PUT', key: null, headers }))
    const replay = await app.handle(send('/items', { method: 'PUT', key: null, headers }))
    await app.handle(send('/items', { key: null, headers }))
    await app.handle(send('/items', { key: null, headers }))
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(runs).toEqual(['put', 'post', 'post'])
  })

  test('a request that fails schema validation creates no record', async () => {
    const store = new ObservedStore()
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ store }))
      .post('/payments', () => ((runs += 1), 'paid'), { body: t.Object({ amount: t.Number() }) })
    const invalid = await app.handle(send('/payments', { body: { amount: 'ten' } }))
    expect(invalid.status).toBe(422)
    expect(store.writes).toEqual([])
    expect(store.inner.size).toBe(0)
    const valid = await app.handle(send('/payments'))
    expect(await valid.text()).toBe('paid')
    expect(runs).toBe(1)
  })
})

describe('idempotency fingerprints', () => {
  test.each<[string, Sent & { readonly path?: string }]>([
    ['body', { body: { amount: 99 } }],
    ['path', { path: '/refunds' }],
    ['method', { method: 'PATCH' }],
  ])('answers 422 when the same key comes with a different %s', async (_, { path = '/payments', ...sent }) => {
    let runs = 0
    const handler = () => ((runs += 1), 'done')
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock() }))
      .post('/payments', handler)
      .patch('/payments', handler)
      .post('/refunds', handler)
    await app.handle(send('/payments'))
    const response = await app.handle(send(path, sent))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'Idempotency-Key was already used with a different request' })
    expect(runs).toBe(1)
  })

  test('fingerprint false replays even when the body changes', async () => {
    const { app, runs } = createApp({ fingerprint: false })
    await app.handle(send('/payments'))
    const replay = await app.handle(send('/payments', { body: { amount: 99 } }))
    expect(runs).toHaveLength(1)
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
  })

  test('a custom fingerprint decides what counts as the same request', async () => {
    const seen: string[] = []
    const fingerprint = ({ request, path }: IdempotencyRequestContext) => {
      seen.push(path)
      return request.headers.get('x-order') ?? ''
    }
    const { app, runs } = createApp({ fingerprint })
    await app.handle(send('/payments', { headers: { 'x-order': 'o1' } }))
    const replay = await app.handle(send('/payments', { body: { amount: 99 }, headers: { 'x-order': 'o1' } }))
    const mismatch = await app.handle(send('/payments', { headers: { 'x-order': 'o2' } }))
    expect(runs).toHaveLength(1)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(mismatch.status).toBe(422)
    expect(seen).toEqual(['/payments', '/payments', '/payments'])
  })

  test('a fingerprint function that returns a non-string fails the request without running the handler', async () => {
    const { app, runs } = createApp({ fingerprint: () => 42 as unknown as string })
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(500)
    expect(runs).toHaveLength(0)
  })
})

describe('idempotency identity', () => {
  test('never replays one identity to another', async () => {
    const { app, runs } = createApp()
    const alice = await app.handle(send('/payments', { headers: { authorization: 'Bearer alice' } }))
    const bob = await app.handle(send('/payments', { headers: { authorization: 'Bearer bob' } }))
    const aliceAgain = await app.handle(send('/payments', { headers: { authorization: 'Bearer alice' } }))
    expect(runs).toHaveLength(2)
    expect(await alice.json()).toEqual({ id: 1, outcome: 'started' })
    expect(await bob.json()).toEqual({ id: 2, outcome: 'started' })
    expect(bob.headers.get('idempotent-replayed')).toBeNull()
    expect(await aliceAgain.json()).toEqual({ id: 1, outcome: 'started' })
  })

  test('ignores X-Forwarded-For unless trustProxy is set', async () => {
    const forwarded = (ip: string) => send('/payments', { headers: { 'x-forwarded-for': ip } })
    const untrusted = createApp()
    await untrusted.app.handle(forwarded('1.1.1.1'))
    await untrusted.app.handle(forwarded('2.2.2.2'))
    expect(untrusted.runs).toHaveLength(1)
    const trusted = createApp({ trustProxy: true })
    await trusted.app.handle(forwarded('1.1.1.1'))
    await trusted.app.handle(forwarded('2.2.2.2'))
    await trusted.app.handle(forwarded('1.1.1.1'))
    expect(trusted.runs).toHaveLength(2)
  })

  test('a custom identity scopes records', async () => {
    const identity = ({ request }: IdempotencyRequestContext) => Promise.resolve(request.headers.get('x-user') ?? 'guest')
    const { app, runs } = createApp({ identity })
    await app.handle(send('/payments', { headers: { 'x-user': 'u1' } }))
    await app.handle(send('/payments', { headers: { 'x-user': 'u2' } }))
    await app.handle(send('/payments', { headers: { 'x-user': 'u1' } }))
    expect(runs).toHaveLength(2)
  })

  test('an identity function that returns a non-string fails the request without running the handler', async () => {
    const { app, runs } = createApp({ identity: () => null as unknown as string })
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(500)
    expect(runs).toHaveLength(0)
  })
})

describe('idempotency release', () => {
  test('a thrown error releases the key and the retry runs again', async () => {
    let runs = 0
    const store = new ObservedStore()
    const app = new Elysia()
      .use(idempotency({ store }))
      .post('/payments', () => {
        runs += 1
        if (runs === 1) throw new Error('database timeout')
        return 'paid'
      })
    const failed = await app.handle(send('/payments'))
    const retried = await app.handle(send('/payments'))
    expect(failed.status).toBe(500)
    expect(await retried.text()).toBe('paid')
    expect(runs).toBe(2)
    expect(store.writes).toEqual(['set', 'delete', 'set', 'set'])
  })

  test.each([500, 503, 409, 429])('a %i response releases the key and the retry runs again', async (code) => {
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock() }))
      .post('/payments', ({ status }) => ((runs += 1), runs === 1 ? status(code, 'later') : 'paid'))
    const first = await app.handle(send('/payments'))
    const retried = await app.handle(send('/payments'))
    expect(first.status).toBe(code)
    expect(await retried.text()).toBe('paid')
    expect(runs).toBe(2)
  })

  test('a custom shouldStore decides which statuses are kept', async () => {
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock(), shouldStore: (status) => status === 201 }))
      .post('/payments', ({ status }) => ((runs += 1), status(runs === 1 ? 400 : 201, 'x')))
    await app.handle(send('/payments'))
    await app.handle(send('/payments'))
    const replay = await app.handle(send('/payments'))
    expect(runs).toBe(2)
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
  })

  test('onAfterResponse releases a lease when an earlier mapResponse skipped ours', async () => {
    const store = new ObservedStore()
    const app = new Elysia()
      .mapResponse(() => new Response('mapped elsewhere'))
      .use(idempotency({ store }))
      .post('/payments', () => 'paid')
    const released = store.next('delete')
    const response = await app.handle(send('/payments'))
    await released
    expect(await response.text()).toBe('mapped elsewhere')
    expect(store.writes).toEqual(['set', 'delete'])
  })

  test('a store failure while finishing still sends the response', async () => {
    const store = new ObservedStore()
    const app = new Elysia()
      .use(idempotency({ store }))
      .post('/payments', () => {
        store.inner.update = async () => {
          throw new Error(SECRET)
        }
        return 'paid'
      })
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('paid')
  })

  test('releases the key when the response cannot be built', async () => {
    const store = new ObservedStore()
    const mapResponse = spyOn(ResponseCapture.prototype, 'toResponse').mockRejectedValueOnce(new Error('broken body'))
    const { app, runs } = createApp({ store })
    const failed = await app.handle(send('/payments'))
    const retried = await app.handle(send('/payments'))
    mapResponse.mockRestore()
    expect(failed.status).toBe(500)
    expect(retried.status).toBe(201)
    expect(runs).toHaveLength(2)
    expect(store.writes.slice(0, 2)).toEqual(['set', 'delete'])
  })

  test('treats corrupt store data as no record', async () => {
    const store = new MemoryStore({ clock: new ManualClock() })
    const storeKey = new KeyBuilder('idempotency').build('anonymous', KEY)
    await store.update(storeKey, () => ({ action: 'set', value: '{"state":"completed"', ttlMs: 60_000, result: null }))
    const { app, runs } = createApp({ store })
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(201)
    expect(runs).toHaveLength(1)
  })
})

describe('idempotency rejections', () => {
  const inProgressApp = (options: IdempotencyPluginOptions = {}) => {
    const store = new MemoryStore({ clock: new ManualClock() })
    const storeKey = new KeyBuilder('idempotency').build('anonymous', KEY)
    const record = JSON.stringify({ state: 'in-progress', token: crypto.randomUUID(), fingerprint: null, startedAt: 0 })
    const ready = store.update(storeKey, () => ({ action: 'set', value: record, ttlMs: 60_000, result: null }))
    return { ready, ...createApp({ store, ...options }) }
  }

  test('answers 409 with Retry-After while the first request runs', async () => {
    const { app, ready, runs } = inProgressApp()
    await ready
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(409)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toEqual({ error: 'A request with this Idempotency-Key is still in progress' })
    expect(runs).toHaveLength(0)
  })

  test('onRejected receives the rejection and can replace the body', async () => {
    const received: IdempotencyRejection[] = []
    const onRejected = (_: IdempotencyRequestContext, rejection: IdempotencyRejection) => {
      received.push(rejection)
      return { problem: rejection.reason }
    }
    const { app, ready } = inProgressApp({ onRejected })
    await ready
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ problem: 'in-progress' })
    expect(received).toEqual([{ reason: 'in-progress', status: 409 }])
  })

  test('onRejected can return a whole Response', async () => {
    const { app } = createApp({ onRejected: () => new Response('custom', { status: 418 }) })
    const response = await app.handle(send('/payments', { key: 'bad key' }))
    expect(response.status).toBe(418)
    expect(await response.text()).toBe('custom')
  })

  test.each<[string, () => unknown]>([
    ['undefined', () => undefined],
    ['null', async () => null],
    ['a thrown error', () => {
      throw new Error(SECRET)
    }],
  ])('falls back to the default body when onRejected gives %s', async (_, onRejected) => {
    const { app, runs } = createApp({ onRejected })
    const response = await app.handle(send('/payments', { key: 'bad key' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Idempotency-Key header is invalid' })
    expect(runs).toHaveLength(0)
  })
})

describe('idempotency failureMode', () => {
  const failures: [string, unknown][] = [
    ['an Error', new Error(SECRET)],
    ['a string', SECRET],
    ['a StoreConflictError', new StoreConflictError(SECRET)],
  ]

  test.each(failures)('answers 503 in closed mode on %s without leaking details', async (_, error) => {
    const { app, runs } = createApp({ store: failingStore(error) })
    const response = await app.handle(send('/payments'))
    const body = await response.text()
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(JSON.parse(body)).toEqual({ error: 'Idempotency is temporarily unavailable' })
    expectNoLeaks(body)
    expect(runs).toHaveLength(0)
  })

  test('runs the handler unprotected in open mode and reports why', async () => {
    const failure = new Error(SECRET)
    let outcome: IdempotencyOutcome | undefined
    const app = new Elysia()
      .use(idempotency({ store: failingStore(failure), failureMode: 'open' }))
      .post('/payments', ({ idempotency: current }) => ((outcome = current), 'paid'))
    const response = await app.handle(send('/payments'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('paid')
    if (outcome?.status !== 'unavailable') throw new Error('Expected an unavailable outcome')
    expect(outcome.error.name).toBe('StoreUnavailableError')
    expect(outcome.error.cause).toBe(failure)
  })

  test('rejection bodies never leak the key or store details', async () => {
    const { app } = createApp()
    await app.handle(send('/payments'))
    const mismatch = await app.handle(send('/payments', { body: { amount: 1 } }))
    expectNoLeaks(await mismatch.text())
  })
})

describe('idempotency scope and instances', () => {
  test("scope 'local' only covers routes on the plugin instance", async () => {
    let runs = 0
    const local = idempotency({ clock: new ManualClock(), scope: 'local' }).post('/inner', () => ((runs += 1), 'inner'))
    const app = new Elysia().use(local).post('/outer', () => ((runs += 1), 'outer'))
    await app.handle(send('/inner'))
    await app.handle(send('/inner'))
    expect(runs).toBe(1)
    await app.handle(send('/outer'))
    await app.handle(send('/outer'))
    expect(runs).toBe(3)
  })

  test("default scope 'scoped' covers the parent but not the grandparent", async () => {
    let runs = 0
    const child = new Elysia().use(idempotency({ clock: new ManualClock() })).post('/child', () => ((runs += 1), 'child'))
    const app = new Elysia().use(child).post('/parent', () => ((runs += 1), 'parent'))
    await app.handle(send('/child'))
    await app.handle(send('/child'))
    expect(runs).toBe(1)
    await app.handle(send('/parent'))
    await app.handle(send('/parent'))
    expect(runs).toBe(3)
  })

  test("scope 'global' covers every route", async () => {
    let runs = 0
    const child = new Elysia().use(idempotency({ clock: new ManualClock(), scope: 'global' }))
    const app = new Elysia().use(new Elysia().use(child)).post('/', () => ((runs += 1), 'ok'))
    await app.handle(send('/'))
    await app.handle(send('/'))
    expect(runs).toBe(1)
  })

  test('two stacked plugins with different prefixes both record and replay', async () => {
    const store = new MemoryStore({ clock: new ManualClock() })
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ store, prefix: 'outer' }))
      .use(idempotency({ store, prefix: 'inner', header: 'X-Inner-Key' }))
      .post('/payments', () => ((runs += 1), 'paid'))
    const headers = { 'x-inner-key': 'inner-1' }
    await app.handle(send('/payments', { headers }))
    const replay = await app.handle(send('/payments', { headers }))
    expect(runs).toBe(1)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(await replay.text()).toBe('paid')
    expect(store.size).toBe(2)
  })

  test('works after a rate limiter that adds headers and can block first', async () => {
    let allowed = 2
    const rateLimiter = new Elysia({ name: 'rate-limiter-double' })
      .onBeforeHandle({ as: 'global' }, ({ set, status }) => {
        allowed -= 1
        set.headers['ratelimit-remaining'] = String(Math.max(0, allowed))
        if (allowed < 0) return status(429, 'Too Many Requests')
        return undefined
      })
    let runs = 0
    const app = new Elysia()
      .use(rateLimiter)
      .use(idempotency({ clock: new ManualClock() }))
      .post('/payments', () => ((runs += 1), 'paid'))
    const first = await app.handle(send('/payments'))
    const replay = await app.handle(send('/payments'))
    const limited = await app.handle(send('/payments'))
    expect(runs).toBe(1)
    expect(first.headers.get('ratelimit-remaining')).toBe('1')
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(replay.headers.get('ratelimit-remaining')).toBe('0')
    expect(limited.status).toBe(429)
    const afterLimit = await app.handle(send('/payments'))
    expect(afterLimit.status).toBe(429)
  })

  test('the idempotency context value is typed for handlers', async () => {
    const app = new Elysia()
      .use(idempotency({ clock: new ManualClock() }))
      .post('/', ({ idempotency: outcome }) => (outcome.status === 'started' ? outcome.key : outcome.status))
    expect(await (await app.handle(send('/'))).text()).toBe(KEY)
  })
})

describe('idempotency on a real server', () => {
  test('replays over HTTP and closes its engine on stop', async () => {
    const close = spyOn(IdempotencyEngine.prototype, 'close')
    const { app, runs } = createApp()
    app.listen(0)
    const url = `http://localhost:${app.server?.port ?? 0}/payments`
    const init = { method: 'POST', headers: { 'idempotency-key': KEY, 'content-type': 'application/json' }, body: '{}' }
    const first = await fetch(url, init)
    const replay = await fetch(url, init)
    await app.stop()
    expect(first.status).toBe(201)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(runs).toHaveLength(1)
    expect(close).toHaveBeenCalled()
    close.mockRestore()
  })
})
