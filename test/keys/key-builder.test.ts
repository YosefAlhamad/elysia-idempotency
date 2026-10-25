import { describe, expect, test } from 'bun:test'
import { KeyBuilder } from '../../src/keys/key-builder'

const SHA256_HEX = /^[0-9a-f]{64}$/

describe('KeyBuilder', () => {
  test('builds prefix:sha256 of the JSON pair in lowercase hex', () => {
    const key = new KeyBuilder('idem').build('auth:token', 'k1')
    const expected = new Bun.CryptoHasher('sha256').update('["auth:token","k1"]').digest('hex')
    expect(key).toBe(`idem:${expected}`)
  })

  test('gives every key the same shape no matter the input', () => {
    for (const value of ['', 'a', 'x'.repeat(10_000), '203.0.113.7', 'ユーザー', ':', '"']) {
      const [prefix, digest, ...rest] = new KeyBuilder('idempotency').build(value, value).split(':')
      expect([prefix, rest]).toEqual(['idempotency', []])
      expect(digest).toMatch(SHA256_HEX)
    }
  })

  test('scopes and keys containing ":" cannot collide', () => {
    const builder = new KeyBuilder('idempotency')
    expect(builder.build('a:b', 'c')).not.toBe(builder.build('a', 'b:c'))
    expect(builder.build('a:', 'b')).not.toBe(builder.build('a', ':b'))
    expect(builder.build('', 'a:b')).not.toBe(builder.build('a:b', ''))
  })

  test('scopes and keys containing \'"\' cannot collide', () => {
    const builder = new KeyBuilder('idempotency')
    expect(builder.build('a","b', 'c')).not.toBe(builder.build('a', 'b","c'))
    expect(builder.build('a"', 'b')).not.toBe(builder.build('a', '"b'))
    expect(builder.build('a\\', 'b')).not.toBe(builder.build('a', '\\b'))
  })

  test('every pair in a mixed set gets its own key', () => {
    const builder = new KeyBuilder('idempotency')
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['a:b', 'c'],
      ['a', 'b:c'],
      ['a","b', 'c'],
      ['a', 'b","c'],
      ['a', 'b'],
      ['b', 'a'],
      ['', 'a:b'],
      ['a:b', ''],
      ['["a","b"]', ''],
    ]
    const keys = pairs.map(([scope, key]) => builder.build(scope, key))
    expect(new Set(keys).size).toBe(pairs.length)
  })

  test('separates keys by prefix', () => {
    expect(new KeyBuilder('one').build('s', 'k')).not.toBe(new KeyBuilder('two').build('s', 'k'))
  })

  test('is stable for the same input', () => {
    const builder = new KeyBuilder('idempotency')
    expect(builder.build('scope', 'key')).toBe(builder.build('scope', 'key'))
  })

  test('never contains the raw scope or key', () => {
    const key = new KeyBuilder('idempotency').build('auth:Bearer secret-token', 'order-42')
    expect(key).not.toContain('secret-token')
    expect(key).not.toContain('order-42')
  })
})
