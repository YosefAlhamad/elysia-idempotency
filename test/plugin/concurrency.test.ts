import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { idempotency } from '../../src/plugin/idempotency-plugin'
import { MemoryStore } from '../../src/stores/memory-store'
import { RedisStore } from '../../src/stores/redis-store'
import type { IdempotencyStore } from '../../src/stores/store'
import { deferred } from '../helpers/deferred'
import { FakeRedis } from '../helpers/fake-redis'
import { ManualClock } from '../helpers/manual-clock'

const CONCURRENT_REQUESTS = 50
const REPLAYS = 10

const stores: [string, () => IdempotencyStore][] = [
  ['memory store', () => new MemoryStore({ clock: new ManualClock() })],
  ['Redis store', () => new RedisStore({ client: new FakeRedis(new ManualClock()) })],
]

const charge = () =>
  new Request('http://localhost/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'pay_123' },
    body: JSON.stringify({ amount: 4_200, currency: 'eur' }),
  })

const snapshot = async (response: Response) => ({
  status: response.status,
  contentType: response.headers.get('content-type'),
  body: await response.arrayBuffer(),
})

describe.each(stores)('fifty concurrent identical requests on the %s', (_, createStore) => {
  test('run the handler once, answer the rest with 409, then replay byte for byte', async () => {
    const gate = deferred()
    const entered = deferred()
    let runs = 0
    const app = new Elysia()
      .use(idempotency({ store: createStore(), clock: new ManualClock() }))
      .post('/payments', async ({ status }) => {
        runs += 1
        entered.resolve()
        await gate.promise
        return status(201, { id: `ch_${runs}`, amount: 4_200 })
      })

    const rejected: Response[] = []
    const pending = Array.from({ length: CONCURRENT_REQUESTS }, () =>
      app.handle(charge()).then((response) => {
        if (response.status !== 201) rejected.push(response)
        if (rejected.length === CONCURRENT_REQUESTS - 1) gate.resolve()
        return response
      }),
    )
    await entered.promise
    const responses = await Promise.all(pending)

    expect(runs).toBe(1)
    const originals = responses.filter((response) => response.status === 201)
    expect(originals).toHaveLength(1)
    expect(rejected.map((response) => response.status)).toEqual(new Array(CONCURRENT_REQUESTS - 1).fill(409))
    expect(rejected.every((response) => response.headers.get('retry-after') === '1')).toBe(true)

    const [original] = originals
    if (original === undefined) throw new Error('Expected one original response')
    const expected = await snapshot(original)
    const replays = await Promise.all(Array.from({ length: REPLAYS }, () => app.handle(charge())))
    expect(runs).toBe(1)
    for (const replay of replays) {
      expect(replay.headers.get('idempotent-replayed')).toBe('true')
      expect(await snapshot(replay)).toEqual(expected)
    }
  })
})
