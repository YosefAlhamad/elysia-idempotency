import type { Server } from 'bun'
import { describe, expect, test } from 'bun:test'
import { ClientIpResolver, type RequestAddressSource, type TrustProxy } from '../../src/keys/client-ip-resolver'

const SOCKET_ADDRESS = '198.51.100.1'

const serverAt = (address: string | null): RequestAddressSource => ({
  requestIP: () => (address === null ? null : { address }),
})

const requestWith = (forwardedFor?: string): Request =>
  new Request('http://localhost/', forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } })

const resolve = (trustProxy: TrustProxy, forwardedFor?: string, socket: string | null = SOCKET_ADDRESS) =>
  new ClientIpResolver(trustProxy).resolve(requestWith(forwardedFor), serverAt(socket))?.toKey(56) ?? null

describe('ClientIpResolver options', () => {
  test.each([0, -1, 33, 1.5, Number.NaN])('rejects trustProxy %p', (trustProxy) => {
    expect(() => new ClientIpResolver(trustProxy)).toThrow(RangeError)
  })

  test('accepts Bun servers as the address source', () => {
    const asSource = (server: Server<undefined>): RequestAddressSource => server
    expect(asSource).toBeFunction()
  })
})

describe('trustProxy: false', () => {
  test('is the default and uses the socket address', () => {
    expect(new ClientIpResolver().resolve(requestWith(), serverAt(SOCKET_ADDRESS))?.toKey(56)).toBe(SOCKET_ADDRESS)
  })

  test('ignores X-Forwarded-For', () => {
    expect(resolve(false, '203.0.113.7')).toBe(SOCKET_ADDRESS)
  })

  test('returns null without a server or socket address', () => {
    expect(new ClientIpResolver(false).resolve(requestWith('203.0.113.7'), null)).toBeNull()
    expect(resolve(false, '203.0.113.7', null)).toBeNull()
    expect(resolve(false, undefined, 'not-an-ip')).toBeNull()
  })

  test('groups an IPv6 socket address by subnet', () => {
    expect(resolve(false, undefined, '2001:db8:abcd:12ff::1')).toBe('2001:db8:abcd:1200::/56')
  })
})

describe('trustProxy: number of hops', () => {
  test('takes the entry the nearest trusted proxy saw', () => {
    expect(resolve(1, '203.0.113.7')).toBe('203.0.113.7')
    expect(resolve(2, '203.0.113.7, 10.0.0.2')).toBe('203.0.113.7')
  })

  test('a client cannot spoof its IP by prepending entries', () => {
    expect(resolve(1, '1.1.1.1, 2.2.2.2, 203.0.113.7')).toBe('203.0.113.7')
    expect(resolve(1, '::ffff:9.9.9.9,203.0.113.7')).toBe('203.0.113.7')
    expect(resolve(2, 'spoofed, 1.1.1.1, 203.0.113.7, 10.0.0.2')).toBe('203.0.113.7')
  })

  test('does not shift past an invalid entry into client-controlled entries', () => {
    expect(resolve(1, '1.1.1.1, unknown')).toBeNull()
    expect(resolve(2, '1.1.1.1, , 10.0.0.2')).toBeNull()
  })

  test('uses the socket address when the list is shorter than the hop count', () => {
    expect(resolve(2, '203.0.113.7')).toBe(SOCKET_ADDRESS)
    expect(resolve(1)).toBe(SOCKET_ADDRESS)
    expect(resolve(1, '   ')).toBe(SOCKET_ADDRESS)
  })

  test('handles brackets, ports and IPv6 entries', () => {
    expect(resolve(1, '[2001:db8:abcd:12ff::1]:443')).toBe('2001:db8:abcd:1200::/56')
    expect(resolve(1, '203.0.113.7:51000')).toBe('203.0.113.7')
  })
})

describe('trustProxy: true', () => {
  test('takes the leftmost entry', () => {
    expect(resolve(true, '203.0.113.7, 10.0.0.1, 10.0.0.2')).toBe('203.0.113.7')
  })

  test('skips leftmost entries that do not parse', () => {
    expect(resolve(true, 'unknown, , 203.0.113.7, 10.0.0.1')).toBe('203.0.113.7')
  })

  test('falls back to the socket address when no entry parses', () => {
    expect(resolve(true, 'unknown, garbage')).toBe(SOCKET_ADDRESS)
    expect(resolve(true)).toBe(SOCKET_ADDRESS)
  })

  test('returns null when nothing parses and there is no socket address', () => {
    expect(resolve(true, 'unknown', null)).toBeNull()
  })
})
