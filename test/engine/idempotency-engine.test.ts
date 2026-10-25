import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { BeginOutcome, IdempotencyLease } from '../../src/engine/begin-outcome'
import { type IdempotencyEngineOptions, idempotencyEngineOptionsSchema } from '../../src/engine/engine-schema'
import { IdempotencyEngine } from '../../src/engine/idempotency-engine'
import { IdempotencyConfigError, IdempotencyError } from '../../src/errors'
import { KeyBuilder } from '../../src/keys/key-builder'
import type { StoredResponse } from '../../src/records/stored-response'
import { MemoryStore } from '../../src/stores/memory-store'
import { RedisStore } from '../../src/stores/redis-store'
import type { IdempotencyStore, StoreMutation } from '../../src/stores/store'
import { FakeRedis } from '../helpers/fake-redis'
import { ManualClock } from '../helpers/manual-clock'

const LOCK_TIMEOUT_MS = 10_000
const RETENTION_MS = 60_000
const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)
const SCOPE = 'auth:token-1'
const KEY = 'key-1'

const created: string = Buffer.from('{"id":1}').toString('base64')

const response = (status = 201, body: string | null = created): StoredResponse => ({
  status,
  headers: [['content-type', 'application/json']],
  body,
  bodyOmitted: false,
})

const openStores: IdempotencyStore[] = []
const openEngines: IdempotencyEngine[] = []

afterEach(async () => {
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()))
  await Promise.all(openStores.splice(0).map((store) => store.close?.()))
})

const createEngine = (options: IdempotencyEngineOptions = {}): IdempotencyEngine => {
  const engine = new IdempotencyEngine(options)
  openEngines.push(engine)
  return engine
}

const leaseOf = (outcome: BeginOutcome): IdempotencyLease => {
  if (outcome.kind !== 'started') throw new Error(`Expected started, got ${outcome.kind}`)
  return outcome.lease
}

const begin = (engine: IdempotencyEngine, fingerprint: string | null = FINGERPRINT, scope = SCOPE, key = KEY) =>
  engine.begin({ scope, key, fingerprint })

const storeKeyFor = (scope = SCOPE, key = KEY) => new KeyBuilder('idempotency').build(scope, key)

const write = (store: IdempotencyStore, key: string, value: string) =>
  store.update(key, () => ({ action: 'set', value, ttlMs: RETENTION_MS, result: undefined }))

type StoreFactory = (clock: ManualClock) => IdempotencyStore

const memoryStore: StoreFactory = (clock) => {
  const store = new MemoryStore({ clock })
  openStores.push(store)
  return store
}

const redisStore: StoreFactory = (clock) => new RedisStore({ client: new FakeRedis(clock) })

const describeEngineContract = (name: string, createStore: StoreFactory) => {
  describe(`IdempotencyEngine with ${name}`, () => {
    const setup = () => {
      const clock = new ManualClock(1_700_000_000_000)
      const store = createStore(clock)
      const engine = createEngine({ store, clock, retention: RETENTION_MS, lockTimeout: LOCK_TIMEOUT_MS })
      return { clock, store, engine }
    }

    test('none, begin: starts with a lease for the hashed store key', async () => {
      const { engine } = setup()
      const lease = leaseOf(await begin(engine))
      expect(lease.storeKey).toBe(storeKeyFor())
      expect(lease.fingerprint).toBe(FINGERPRINT)
      expect(lease.token).toMatch(/^[0-9a-f-]{36}$/)
    })

    test('fifty concurrent begins start exactly once', async () => {
      const { engine } = setup()
      const outcomes = await Promise.all(Array.from({ length: 50 }, () => begin(engine)))
      expect(outcomes.filter((outcome) => outcome.kind === 'started')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.kind === 'in-progress')).toHaveLength(49)
    })

    test('in-progress, begin with the same key: reports in-progress', async () => {
      const { engine } = setup()
      await begin(engine)
      expect(await begin(engine)).toEqual({ kind: 'in-progress' })
      expect(await begin(engine, OTHER_FINGERPRINT)).toEqual({ kind: 'in-progress' })
    })

    test('in-progress, complete: stores the response for replay', async () => {
      const { engine } = setup()
      const lease = leaseOf(await begin(engine))
      expect(await engine.complete(lease, response())).toBe(true)
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response() })
    })

    test('in-progress, release: removes the record so a retry runs again', async () => {
      const { engine } = setup()
      const lease = leaseOf(await begin(engine))
      expect(await engine.release(lease)).toBe(true)
      expect((await begin(engine)).kind).toBe('started')
    })

    test('in-progress, lock TTL expires: a retry runs again', async () => {
      const { clock, engine } = setup()
      const first = leaseOf(await begin(engine))
      clock.advance(LOCK_TIMEOUT_MS - 1)
      expect(await begin(engine)).toEqual({ kind: 'in-progress' })
      clock.advance(1)
      const second = leaseOf(await begin(engine))
      expect(second.token).not.toBe(first.token)
    })

    test('completed, begin with the same fingerprint: replays the stored response', async () => {
      const { engine } = setup()
      await engine.complete(leaseOf(await begin(engine)), response(402))
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response(402) })
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response(402) })
    })

    test('completed, begin with another fingerprint: reports a mismatch and keeps the record', async () => {
      const { engine } = setup()
      await engine.complete(leaseOf(await begin(engine)), response())
      expect(await begin(engine, OTHER_FINGERPRINT)).toEqual({ kind: 'mismatch' })
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response() })
    })

    test('completed, retention TTL expires: a retry runs as a new request', async () => {
      const { clock, engine } = setup()
      await engine.complete(leaseOf(await begin(engine)), response())
      clock.advance(RETENTION_MS - 1)
      expect((await begin(engine)).kind).toBe('replay')
      clock.advance(1)
      expect((await begin(engine)).kind).toBe('started')
    })

    test('a stale lease can neither complete nor release the new holder', async () => {
      const { clock, engine } = setup()
      const stale = leaseOf(await begin(engine))
      clock.advance(LOCK_TIMEOUT_MS)
      const current = leaseOf(await begin(engine))
      expect(await engine.complete(stale, response(200))).toBe(false)
      expect(await engine.release(stale)).toBe(false)
      expect(await begin(engine)).toEqual({ kind: 'in-progress' })
      expect(await engine.complete(current, response(201))).toBe(true)
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response(201) })
    })

    test('a stale lease cannot overwrite or delete a completed record', async () => {
      const { clock, engine } = setup()
      const stale = leaseOf(await begin(engine))
      clock.advance(LOCK_TIMEOUT_MS)
      await engine.complete(leaseOf(await begin(engine)), response(201))
      expect(await engine.complete(stale, response(200))).toBe(false)
      expect(await engine.release(stale)).toBe(false)
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response(201) })
    })

    test('an expired lease nobody claimed can still complete', async () => {
      const { clock, engine } = setup()
      const lease = leaseOf(await begin(engine))
      clock.advance(LOCK_TIMEOUT_MS)
      expect(await engine.complete(lease, response())).toBe(true)
      expect(await begin(engine)).toEqual({ kind: 'replay', response: response() })
    })

    test('an expired lease nobody claimed has nothing to release', async () => {
      const { clock, engine } = setup()
      const lease = leaseOf(await begin(engine))
      clock.advance(LOCK_TIMEOUT_MS)
      expect(await engine.release(lease)).toBe(false)
    })

    test('records never cross scopes', async () => {
      const { engine } = setup()
      await engine.complete(leaseOf(await begin(engine)), response())
      expect((await begin(engine, FINGERPRINT, 'auth:token-2')).kind).toBe('started')
      expect((await begin(engine, FINGERPRINT, SCOPE, 'key-2')).kind).toBe('started')
    })

    test('treats corrupt JSON in the store as no record', async () => {
      const { store, engine } = setup()
      await write(store, storeKeyFor(), '{not json')
      const lease = leaseOf(await begin(engine))
      expect(await engine.complete(lease, response())).toBe(true)
      expect((await begin(engine)).kind).toBe('replay')
    })

    test('treats wrong-shape data in the store as no record', async () => {
      const { store, engine } = setup()
      const forged = { state: 'completed', fingerprint: FINGERPRINT, completedAt: 1, response: { status: 200 } }
      await write(store, storeKeyFor(), JSON.stringify(forged))
      expect((await begin(engine)).kind).toBe('started')
    })

    test('completes a lease whose record was corrupted, and cannot release it', async () => {
      const { store, engine } = setup()
      const lease = leaseOf(await begin(engine))
      await write(store, lease.storeKey, 'garbage')
      expect(await engine.release(lease)).toBe(false)
      expect(await engine.complete(lease, response())).toBe(true)
      expect((await begin(engine)).kind).toBe('replay')
    })
  })
}

describeEngineContract('MemoryStore', memoryStore)
describeEngineContract('RedisStore', redisStore)

describe('IdempotencyEngine fingerprints', () => {
  const setup = () => createEngine({ clock: new ManualClock() })

  test('replays when the stored fingerprint is null', async () => {
    const engine = setup()
    await engine.complete(leaseOf(await begin(engine, null)), response())
    expect((await begin(engine, FINGERPRINT)).kind).toBe('replay')
  })

  test('replays when the incoming fingerprint is null', async () => {
    const engine = setup()
    await engine.complete(leaseOf(await begin(engine, FINGERPRINT)), response())
    expect((await begin(engine, null)).kind).toBe('replay')
  })

  test('rejects a fingerprint that is not 64 lowercase hex characters', async () => {
    const engine = setup()
    await expect(begin(engine, 'A'.repeat(64))).rejects.toThrow(TypeError)
    await expect(begin(engine, 'abc')).rejects.toThrow('fingerprint')
  })

  test('rejects a scope that is not a string and an empty key', async () => {
    const engine = setup()
    const input = { scope: SCOPE, key: KEY, fingerprint: null }
    await expect(engine.begin({ ...input, scope: undefined as unknown as string })).rejects.toThrow('scope')
    await expect(engine.begin({ ...input, key: '' })).rejects.toThrow('key')
  })
})

describe('IdempotencyEngine store usage', () => {
  const countingStore = () => {
    const inner = new MemoryStore({ clock: new ManualClock() })
    openStores.push(inner)
    const calls = { read: 0, update: 0, delete: 0 }
    const store: IdempotencyStore = {
      read: (key) => {
        calls.read += 1
        return inner.read(key)
      },
      update: <TResult>(key: string, mutation: StoreMutation<TResult>) => {
        calls.update += 1
        return inner.update(key, mutation)
      },
      delete: (key) => {
        calls.delete += 1
        return inner.delete(key)
      },
    }
    return { store, calls }
  }

  test('each method is exactly one update call', async () => {
    const { store, calls } = countingStore()
    const engine = createEngine({ store })
    const lease = leaseOf(await begin(engine))
    expect(calls).toEqual({ read: 0, update: 1, delete: 0 })
    await engine.complete(lease, response())
    expect(calls).toEqual({ read: 0, update: 2, delete: 0 })
    await engine.release(lease)
    expect(calls).toEqual({ read: 0, update: 3, delete: 0 })
  })

  test('rejects an invalid response and leaves the lock in place', async () => {
    const engine = createEngine({ clock: new ManualClock() })
    const lease = leaseOf(await begin(engine))
    await expect(engine.complete(lease, response(100))).rejects.toThrow(IdempotencyError)
    expect(await begin(engine)).toEqual({ kind: 'in-progress' })
  })
})

describe('IdempotencyEngine close', () => {
  test('closes the store it created', async () => {
    const close = spyOn(MemoryStore.prototype, 'close')
    try {
      await new IdempotencyEngine().close()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
    }
  })

  test('never closes a store the caller passed in', async () => {
    const store = new MemoryStore()
    openStores.push(store)
    const close = spyOn(store, 'close')
    await new IdempotencyEngine({ store }).close()
    expect(close).not.toHaveBeenCalled()
  })

  test('works with a store that has no close method', async () => {
    const inner = new MemoryStore()
    openStores.push(inner)
    const store: IdempotencyStore = {
      read: (key) => inner.read(key),
      update: (key, mutation) => inner.update(key, mutation),
      delete: (key) => inner.delete(key),
    }
    await expect(new IdempotencyEngine({ store }).close()).resolves.toBeUndefined()
  })
})

describe('IdempotencyEngine options', () => {
  const configError = (options: unknown): IdempotencyConfigError => {
    try {
      new IdempotencyEngine(options as IdempotencyEngineOptions)
    } catch (error) {
      if (error instanceof IdempotencyConfigError) return error
      throw error
    }
    throw new Error('Expected an IdempotencyConfigError')
  }

  test('applies the defaults', () => {
    const settings = idempotencyEngineOptionsSchema.parse({})
    expect(settings).toEqual({ prefix: 'idempotency', retentionMs: 86_400_000, lockTimeoutMs: 60_000 })
  })

  test('parses duration strings into milliseconds', () => {
    const settings = idempotencyEngineOptionsSchema.parse({ retention: '7d', lockTimeout: '30s' })
    expect(settings.retentionMs).toBe(604_800_000)
    expect(settings.lockTimeoutMs).toBe(30_000)
  })

  test('uses the prefix in store keys', async () => {
    const engine = createEngine({ prefix: 'payments', clock: new ManualClock() })
    expect(leaseOf(await begin(engine)).storeKey).toBe(new KeyBuilder('payments').build(SCOPE, KEY))
  })

  test.each([
    [{ retentoin: '1h' }, 'retentoin'],
    [{ prefix: 'has space' }, 'prefix'],
    [{ prefix: '' }, 'prefix'],
    [{ retention: '500ms' }, 'retention'],
    [{ retention: '31d' }, 'retention'],
    [{ retention: 'forever' }, 'retention'],
    [{ lockTimeout: '999ms' }, 'lockTimeout'],
    [{ lockTimeout: '2h', retention: '1d' }, 'lockTimeout'],
    [{ lockTimeout: '2m', retention: '1m' }, 'lockTimeout'],
    [{ store: {} }, 'store'],
    [{ clock: { now: 1 } }, 'clock'],
  ])('rejects %j naming %s', (options, field) => {
    const error = configError(options)
    expect(error.message).toContain(field)
  })

  test('rejects options that are not an object', () => {
    expect(configError(null).message).toContain('expected object')
    expect(configError('24h').message).toContain('expected object')
  })

  test('allows a lockTimeout equal to retention', () => {
    expect(idempotencyEngineOptionsSchema.parse({ lockTimeout: '1m', retention: '1m' }).lockTimeoutMs).toBe(60_000)
  })
})
