import { describe, expect, test } from 'bun:test'
import { HeaderFilter, MAX_HEADER_NAME_LENGTH, MAX_HEADER_VALUE_LENGTH } from '../../src/records/header-filter'

const ALWAYS_EXCLUDED = [
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
  'connection',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'date',
  'idempotent-replayed',
  'retry-after',
]

describe('HeaderFilter', () => {
  test.each(ALWAYS_EXCLUDED)('always excludes %p', (name) => {
    expect(new HeaderFilter().allows(name, 'v')).toBe(false)
    expect(HeaderFilter.isAlwaysExcluded(name)).toBe(true)
    expect(HeaderFilter.isAlwaysExcluded(name.toUpperCase())).toBe(true)
    expect(HeaderFilter.isStorable(name, 'v')).toBe(false)
  })

  test.each(['ratelimit', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-policy'])(
    'excludes the rate limit header %p',
    (name) => {
      expect(new HeaderFilter().allows(name, '1')).toBe(false)
      expect(HeaderFilter.isAlwaysExcluded(name.toUpperCase())).toBe(true)
    },
  )

  test.each(['content-type', 'location', 'etag', 'cache-control', 'x-request-id', 'x-ratelimit-note'])(
    'allows %p by default',
    (name) => {
      expect(new HeaderFilter().allows(name, 'v')).toBe(true)
      expect(HeaderFilter.isAlwaysExcluded(name)).toBe(false)
    },
  )

  test('adds user exclusions case-insensitively', () => {
    const filter = new HeaderFilter(['X-Request-Id', 'etag'])
    expect(filter.allows('x-request-id', '1')).toBe(false)
    expect(filter.allows('etag', '"v"')).toBe(false)
    expect(filter.allows('content-type', 'text/plain')).toBe(true)
  })

  test('rejects names that are not lowercase tokens', () => {
    expect(HeaderFilter.isStorable('Content-Type', 'text/plain')).toBe(false)
    expect(HeaderFilter.isStorable('', 'v')).toBe(false)
    expect(HeaderFilter.isStorable('x a', 'v')).toBe(false)
    expect(HeaderFilter.isStorable('x:a', 'v')).toBe(false)
    expect(new HeaderFilter().allows('Set-Cookie', 's=1')).toBe(false)
  })

  test('limits name and value length', () => {
    expect(HeaderFilter.isStorable('x'.repeat(MAX_HEADER_NAME_LENGTH), 'v')).toBe(true)
    expect(HeaderFilter.isStorable('x'.repeat(MAX_HEADER_NAME_LENGTH + 1), 'v')).toBe(false)
    expect(HeaderFilter.isStorable('x-a', 'v'.repeat(MAX_HEADER_VALUE_LENGTH))).toBe(true)
    expect(HeaderFilter.isStorable('x-a', 'v'.repeat(MAX_HEADER_VALUE_LENGTH + 1))).toBe(false)
  })

  test.each(['a\u0000b', 'a\rb', 'a\nb', 'a\r\nset-cookie: s=1', '\u{1f511}', 'Ā'])(
    'rejects the header value %p',
    (value) => {
      expect(HeaderFilter.isStorable('x-a', value)).toBe(false)
    },
  )

  test.each(['', 'plain', 'a\tb', 'a\u0001b', 'a\u007fb', 'café', 'ÿ'])('accepts the header value %p', (value) => {
    expect(HeaderFilter.isStorable('x-a', value)).toBe(true)
  })
})
