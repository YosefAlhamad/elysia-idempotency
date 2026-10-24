import { RedisClient } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { IdempotencyConfigError, StoreConflictError, StoreUnavailableError } from '../../src/errors'
import { type RedisCommandClient, RedisStore } from '../../src/stores/redis-store'
import { FakeRedis } from '../helpers/fake-redis'
import { ManualClock } from '../helpers/manual-clock'

const REDIS_URL = process.env.REDIS_URL

const counter = (ttlMs = 10_000) => (current: string | null) => {
  const next = Number(current ?? '0') + 1
  return { action: 'set' as const, value: String(next), ttlMs, result: next }
}

const remove = () => ({ action: 'delete' as const, result: 'removed' })

const peek = (current: string | null) => ({ action: 'keep' as const, result: current })

const uniqueKey =() => `elysia-idempotency-test:${crypto.randomUUID()}`

const describeRedisStoreContract = (name: string, client: () => RedisCommandClient) => {
  describe(`RedisStore contract (${name})`, () => {
    const usedKeys: string[] = []

    const newKey = () => {
      const key = uniqueKey()
      usedKeys.push(key)
      return key
    }

    afterAll(async () => {
      if (usedKeys.length > 0) await client().send('DEL', usedKeys)
    })

    test('passes null for a missing key and stores each update', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      expect(await store.update(key, counter())).toBe(1)
      expect(await store.update(key, counter())).toBe(2)
      expect(await client().send('GET', [key])).toBe('2')
    })

    test('writes the value with the TTL in milliseconds', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      await store.update(key, counter(5_000))
      const ttl = Number(await client().send('PTTL', [key]))
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(5_000)
    })

    test('retries when another writer changes the key mid-update', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      const seen: (string | null)[] = []
      const writes: Promise<unknown>[] = []
      const result = await store.update(key, (current) => {
        seen.push(current)
        if (seen.length === 1) writes.push(client().send('SET', [key, '41', 'PX', '10000']))
        return counter()(current)
      })
      await Promise.all(writes)
      expect(seen).toEqual([null, '41'])
      expect(result).toBe(42)
      expect(await client().send('GET', [key])).toBe('42')
    })

    test('reads a value without writing it', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      expect(await store.read(key)).toBeNull()
      expect(await client().send('GET', [key])).toBeNull()
      await store.update(key, counter())
      expect(await store.read(key)).toBe('1')
    })

    test('deletes a key', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      await store.update(key, counter())
      await store.delete(key)
      expect(await client().send('GET', [key])).toBeNull()
    })

    test('removes a key with a delete action', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      await store.update(key, counter())
      expect(await store.update(key, remove)).toBe('removed')
      expect(await client().send('GET', [key])).toBeNull()
    })

    test('finishes a delete action on a missing key', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      expect(await store.update(key, remove)).toBe('removed')
      expect(await client().send('GET', [key])).toBeNull()
    })

    test('returns the current value for a keep without changing it', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      const missing = newKey()
      await store.update(key, counter())
      expect(await store.update(key, peek)).toBe('1')
      expect(await store.update(missing, peek)).toBeNull()
      expect(await client().send('GET', [key])).toBe('1')
      expect(await client().send('GET', [missing])).toBeNull()
    })

    test('retries a delete when another writer changes the key mid-update', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      await store.update(key, counter())
      const seen: (string | null)[] = []
      const writes: Promise<unknown>[] = []
      const result = await store.update(key, (current) => {
        seen.push(current)
        if (seen.length === 1) writes.push(client().send('SET', [key, '41', 'PX', '10000']))
        return remove()
      })
      await Promise.all(writes)
      expect(seen).toEqual(['1', '41'])
      expect(result).toBe('removed')
      expect(await client().send('GET', [key])).toBeNull()
    })

    test('does not delete a key that changed and the retry chose to keep', async () => {
      const store = new RedisStore({ client: client() })
      const key = newKey()
      const seen: (string | null)[] = []
      const writes: Promise<unknown>[] = []
      const result = await store.update(key, (current) => {
        seen.push(current)
        if (current === null) {
          writes.push(client().send('SET', [key, 'other', 'PX', '10000']))
          return remove()
        }
        return peek(current)
      })
      await Promise.all(writes)
      expect(seen).toEqual([null, 'other'])
      expect(result).toBe('other')
      expect(await client().send('GET', [key])).toBe('other')
    })
  })
}

describe('RedisStore options', () => {
  test.each<[string, Record<string, unknown>]>([
    ['client', {}],
    ['client', { client: { send: 'no' } }],
    ['maxAttempts', { client: new FakeRedis(), maxAttempts: 0 }],
    ['maxAttempts', { client: new FakeRedis(), maxAttempts: 21 }],
    ['maxAttempts', { client: new FakeRedis(), maxAttempts: 1.5 }],
    ['maxAtempts', { client: new FakeRedis(), maxAtempts: 10 }],
  ])('rejects invalid %s', (field, options) => {
    const create = () => new RedisStore(options as unknown as ConstructorParameters<typeof RedisStore>[0])
    expect(create).toThrow(IdempotencyConfigError)
    expect(create).toThrow(field)
  })

  test('rejects missing options from untyped callers', () => {
    const create = () => new RedisStore(undefined as unknown as ConstructorParameters<typeof RedisStore>[0])
    expect(create).toThrow(IdempotencyConfigError)
  })

  test('accepts maxAttempts from 1 to 20', () => {
    expect(() => new RedisStore({ client: new FakeRedis(), maxAttempts: 1 })).not.toThrow()
    expect(() => new RedisStore({ client: new FakeRedis(), maxAttempts: 20 })).not.toThrow()
  })
})

const sharedFake = new FakeRedis()
describeRedisStoreContract('fake', () => sharedFake)

describe('RedisStore with FakeRedis', () => {
  test('expires values after their TTL', async () => {
    const clock = new ManualClock()
    const redis = new FakeRedis(clock)
    const store = new RedisStore({ client: redis })
    await store.update('a', counter(1_000))
    clock.advance(999)
    expect(redis.get('a')).toBe('1')
    clock.advance(1)
    expect(await store.update('a', counter(1_000))).toBe(1)
  })

  test('rounds fractional TTLs up to whole milliseconds, at least 1', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis })
    await store.update('a', () => ({ action: 'set', value: 'x', ttlMs: 0.2, result: undefined }))
    expect(await redis.send('PTTL', ['a'])).toBe(1)
    await store.update('b', () => ({ action: 'set', value: 'x', ttlMs: 1_500.4, result: undefined }))
    expect(await redis.send('PTTL', ['b'])).toBe(1_501)
  })

  test('rejects a non-finite TTL', async () => {
    const store = new RedisStore({ client: new FakeRedis() })
    const write = store.update('a', () => ({ action: 'set', value: 'x', ttlMs: Number.NaN, result: undefined }))
    await expect(write).rejects.toThrow(RangeError)
  })

  test('succeeds on retry after a forced conflict', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis })
    let conflicts = 0
    redis.onBeforeScript(() => {
      if (conflicts > 0) return
      conflicts += 1
      redis.set('a', '10', 10_000)
    })
    expect(await store.update('a', counter())).toBe(11)
    expect(redis.get('a')).toBe('11')
    expect(redis.commands.filter((command) => command === 'GET')).toHaveLength(2)
  })

  test('detects a conflict when an existing key is deleted mid-update', async () => {
    const redis = new FakeRedis()
    redis.set('a', '5', 10_000)
    const store = new RedisStore({ client: redis })
    let deleted = false
    redis.onBeforeScript(() => {
      if (deleted) return
      deleted = true
      redis.delete('a')
    })
    expect(await store.update('a', counter())).toBe(1)
  })

  test('never conflicts with itself when many updates hit one key at once', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis, maxAttempts: 1 })
    const results = await Promise.all(Array.from({ length: 200 }, () => store.update('hot', counter())))
    expect(results).toEqual(Array.from({ length: 200 }, (_, index) => index + 1))
    expect(redis.get('hot')).toBe('200')
  })

  test('runs a delete after the updates queued before it', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis })
    const updates = [store.update('a', counter()), store.update('a', counter())]
    await store.delete('a')
    expect(await Promise.all(updates)).toEqual([1, 2])
    expect(redis.get('a')).toBeNull()
  })

  test('throws StoreConflictError after maxAttempts conflicts', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis, maxAttempts: 3 })
    let writes = 0
    redis.onBeforeScript(() => {
      writes += 1
      redis.set('a', `other-${writes}`, 10_000)
    })
    const update = store.update('a', counter())
    await expect(update).rejects.toBeInstanceOf(StoreConflictError)
    expect(writes).toBe(3)
  })

  test('returns a keep after GET without sending a script', async () => {
    const redis = new FakeRedis()
    redis.set('a', 'stored', 10_000)
    const store = new RedisStore({ client: redis, maxAttempts: 1 })
    let scripts = 0
    redis.onBeforeScript(() => {
      scripts += 1
    })
    expect(await store.update('a', peek)).toBe('stored')
    expect(await store.update('b', peek)).toBeNull()
    expect(redis.commands).toEqual(['GET', 'GET'])
    expect(scripts).toBe(0)
  })

  test('sends a delete action through the script', async () => {
    const redis = new FakeRedis()
    redis.set('a', 'stored', 10_000)
    const store = new RedisStore({ client: redis })
    expect(await store.update('a', remove)).toBe('removed')
    expect(redis.get('a')).toBeNull()
    expect(redis.commands).toEqual(['GET', 'EVALSHA', 'EVAL'])
  })

  test('retries a delete after a forced conflict', async () => {
    const redis = new FakeRedis()
    redis.set('a', 'first', 10_000)
    const store = new RedisStore({ client: redis })
    const seen: (string | null)[] = []
    let conflicts = 0
    redis.onBeforeScript(() => {
      if (conflicts > 0) return
      conflicts += 1
      redis.set('a', 'second', 10_000)
    })
    const result = await store.update('a', (current) => {
      seen.push(current)
      return remove()
    })
    expect(result).toBe('removed')
    expect(seen).toEqual(['first', 'second'])
    expect(redis.get('a')).toBeNull()
  })

  test('does not delete a key created by another writer mid-update', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis, maxAttempts: 1 })
    redis.onBeforeScript(() => {
      redis.set('a', 'other', 10_000)
    })
    await expect(store.update('a', remove)).rejects.toBeInstanceOf(StoreConflictError)
    expect(redis.get('a')).toBe('other')
  })

  test('throws StoreConflictError when a delete conflicts maxAttempts times', async () => {
    const redis = new FakeRedis()
    redis.set('a', 'start', 10_000)
    const store = new RedisStore({ client: redis, maxAttempts: 3 })
    let writes = 0
    redis.onBeforeScript(() => {
      writes += 1
      redis.set('a', `other-${writes}`, 10_000)
    })
    const update = store.update('a', remove)
    await expect(update).rejects.toBeInstanceOf(StoreConflictError)
    expect(writes).toBe(3)
    expect(redis.get('a')).toBe('other-3')
  })

  test('uses EVALSHA once the script is cached', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis })
    await store.update('a', counter())
    await store.update('a', counter())
    expect(redis.commands).toEqual(['GET', 'EVALSHA', 'EVAL', 'GET', 'EVALSHA'])
  })

  test('falls back to EVAL on NOSCRIPT after the script cache is flushed', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis })
    await store.update('a', counter())
    redis.flushScripts()
    expect(await store.update('a', counter())).toBe(2)
    expect(redis.commands.slice(-3)).toEqual(['GET', 'EVALSHA', 'EVAL'])
  })

  test('uses EVALSHA alone once the script is preloaded with SCRIPT LOAD', async () => {
    const redis = new FakeRedis()
    const scripts: string[] = []
    const client: RedisCommandClient = {
      send: (command, args) => {
        if (command === 'EVAL') scripts.push(args[0] ?? '')
        return redis.send(command, args)
      },
    }
    const store = new RedisStore({ client })
    await store.update('a', counter())
    redis.flushScripts()
    const [script] = scripts
    if (script === undefined) throw new Error('expected the script to be sent with EVAL')
    await redis.send('SCRIPT', ['LOAD', script])
    await store.update('a', counter())
    expect(redis.commands.slice(-2)).toEqual(['GET', 'EVALSHA'])
  })

  test('wraps client errors in StoreUnavailableError with the cause', async () => {
    const redis = new FakeRedis()
    const store = new RedisStore({ client: redis })
    const failure = new Error('connection refused to redis://secret-host')
    redis.failWith(failure)
    for (const operation of [() => store.update('a', counter()), () => store.update('a', peek), () => store.delete('a')]) {
      const error = await operation().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(StoreUnavailableError)
      expect(error).toHaveProperty('cause', failure)
      expect(String(error)).not.toContain('secret-host')
    }
  })

  test('wraps script errors other than NOSCRIPT', async () => {
    const failure = new Error('BUSY Redis is busy running a script')
    const client: RedisCommandClient = {
      send: async (command) => {
        if (command === 'GET') return null
        throw failure
      },
    }
    const error = await new RedisStore({ client }).update('a', counter()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StoreUnavailableError)
    expect(error).toHaveProperty('cause', failure)
  })

  test.each<[string, unknown]>([
    ['null', null],
    ['a word', 'OK'],
    ['a number other than 0 or 1', 2],
  ])('rejects %s as a script reply', async (_, reply) => {
    const client: RedisCommandClient = { send: async (command) => (command === 'GET' ? null : reply) }
    await expect(new RedisStore({ client }).update('a', counter())).rejects.toBeInstanceOf(StoreUnavailableError)
  })

  test.each<[string, unknown]>([
    ['numbers', 1],
    ['strings', '1'],
    ['bigints', 1n],
  ])('accepts script replies as %s', async (_, reply) => {
    const client: RedisCommandClient = { send: async (command) => (command === 'GET' ? null : reply) }
    expect(await new RedisStore({ client }).update('a', counter())).toBe(1)
  })

  test('rejects an unexpected GET reply without retrying', async () => {
    const client: RedisCommandClient = { send: async () => 42 }
    const update = new RedisStore({ client }).update('a', counter())
    await expect(update).rejects.toBeInstanceOf(StoreUnavailableError)
  })

  test('never puts the key or value into the script text', async () => {
    const scripts: string[] = []
    const redis = new FakeRedis()
    const client: RedisCommandClient = {
      send: (command, args) => {
        if (command === 'EVAL' || command === 'EVALSHA') scripts.push(args[0] ?? '')
        return redis.send(command, args)
      },
    }
    const key = "a') redis.call('FLUSHALL') --"
    await new RedisStore({ client }).update(key, () => ({ action: 'set', value: key, ttlMs: 1_000, result: undefined }))
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) expect(script).not.toContain('FLUSHALL')
    expect(redis.get(key)).toBe(key)
  })
})

describe.skipIf(REDIS_URL === undefined)('RedisStore with a real Redis', () => {
  const realClient = new RedisClient(REDIS_URL)

  afterAll(() => {
    realClient.close()
  })

  describeRedisStoreContract('real', () => realClient)
})
