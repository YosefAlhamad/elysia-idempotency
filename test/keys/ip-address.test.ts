import { describe, expect, test } from 'bun:test'
import { IpAddress } from '../../src/keys/ip-address'

const keyOf = (input: string, ipv6Subnet = 128): string | null => IpAddress.parse(input)?.toKey(ipv6Subnet) ?? null

describe('IpAddress.parse with IPv4', () => {
  test.each([
    ['203.0.113.7', '203.0.113.7'],
    ['  203.0.113.7  ', '203.0.113.7'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['203.0.113.7:8080', '203.0.113.7'],
  ])('%p becomes %p', (input, expected) => {
    expect(keyOf(input)).toBe(expected)
  })

  test('ignores ipv6Subnet', () => {
    expect(keyOf('203.0.113.7', 0)).toBe('203.0.113.7')
  })
})

describe('IpAddress.parse with IPv6', () => {
  test.each([
    ['2001:db8:0:0:0:0:0:1', '2001:db8::1/128'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1/128'],
    ['2001:DB8::1', '2001:db8::1/128'],
    ['::1', '::1/128'],
    ['::', '::/128'],
    ['fe80::', 'fe80::/128'],
    ['2001:db8::1:0:0:1', '2001:db8::1:0:0:1/128'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1/128'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3/128'],
    ['64:ff9b::192.0.2.33', '64:ff9b::c000:221/128'],
  ])('%p expands and normalises to %p', (input, expected) => {
    expect(keyOf(input)).toBe(expected)
  })

  test.each([
    ['[2001:db8::1]', '2001:db8::1/128'],
    ['[2001:db8::1]:443', '2001:db8::1/128'],
    ['fe80::1%eth0', 'fe80::1/128'],
    ['[fe80::1%25en0]:80', 'fe80::1/128'],
  ])('strips brackets, ports and zone ids from %p', (input, expected) => {
    expect(keyOf(input)).toBe(expected)
  })

  test.each([
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['[::ffff:203.0.113.7]:8080', '203.0.113.7'],
  ])('turns IPv4-mapped %p into plain IPv4', (input, expected) => {
    expect(keyOf(input, 56)).toBe(expected)
  })

  test('does not treat other embedded IPv4 forms as mapped', () => {
    expect(keyOf('::203.0.113.7')).toBe('::cb00:7107/128')
    expect(keyOf('::fffe:203.0.113.7')).toBe('::fffe:cb00:7107/128')
  })
})

describe('IpAddress.parse with invalid input', () => {
  test.each([
    '',
    '   ',
    'localhost',
    'unknown',
    '256.0.0.1',
    '01.2.3.4',
    '1.2.3',
    '1.2.3.4.5',
    '2001:db8::1::2',
    '2001:db8:0:0:0:0:0:0:1',
    'gggg::1',
    '[2001:db8::1',
    '2001:db8::1]',
    '203.0.113.7:',
    '203.0.113.7:port',
    '::ffff:999.0.0.1',
    '%eth0',
    '[203.0.113.7]',
    '[203.0.113.7]:80',
    '203.0.113.7%eth0',
  ])('rejects %p', (input) => {
    expect(IpAddress.parse(input)).toBeNull()
  })
})

describe('IpAddress.toKey subnet grouping', () => {
  test('masks to /64', () => {
    expect(keyOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 64)).toBe('2001:db8:1:2::/64')
  })

  test('masks to /56 inside a group', () => {
    expect(keyOf('2001:db8:1:2ff:aaaa::1', 56)).toBe('2001:db8:1:200::/56')
  })

  test('addresses in the same /56 share one key, a different /56 does not', () => {
    const first = keyOf('2001:db8:abcd:1200::1', 56)
    expect(keyOf('2001:db8:abcd:12ff:ffff:ffff:ffff:ffff', 56)).toBe(first)
    expect(keyOf('2001:db8:abcd:1300::1', 56)).not.toBe(first)
  })

  test('addresses in the same /64 share one key, a different /64 does not', () => {
    const first = keyOf('2001:db8::1', 64)
    expect(keyOf('2001:db8::ffff:ffff:ffff:ffff', 64)).toBe(first)
    expect(keyOf('2001:db8:0:1::1', 64)).not.toBe(first)
  })

  test.each([
    [0, '::/0'],
    [1, '::/1'],
    [3, '2000::/3'],
    [17, '2001::/17'],
    [24, '2001:d00::/24'],
    [127, '2001:db8:ffff:ffff:ffff:ffff:ffff:fffe/127'],
    [128, '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff/128'],
  ])('handles prefix length %p', (prefix, expected) => {
    expect(keyOf('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', prefix)).toBe(expected)
  })

  test.each([-1, 129, 56.5, Number.NaN])('rejects ipv6Subnet %p', (prefix) => {
    const address = IpAddress.parse('2001:db8::1')
    expect(() => address?.toKey(prefix)).toThrow(RangeError)
  })
})
