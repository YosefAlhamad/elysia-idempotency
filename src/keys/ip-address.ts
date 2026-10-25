import { isIP } from 'node:net'

const IPV6_GROUP_COUNT = 8
const IPV6_GROUP_BITS = 16
const IPV6_BITS = 128
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/
const BRACKETED = /^\[([^\]]*:[^\]]*)\](?::\d{1,5})?$/

export class IpAddress {
  private constructor(
    private readonly version: 4 | 6,
    private readonly parts: readonly number[],
  ) {}

  static parse(input: string): IpAddress | null {
    const candidate = IpAddress.stripDecorations(input.trim())
    const family = isIP(candidate)
    if (family === 4) return new IpAddress(4, IpAddress.ipv4Octets(candidate))
    if (family !== 6) return null
    const groups = IpAddress.expandIpv6(candidate)
    if (IpAddress.isIpv4Mapped(groups)) return new IpAddress(4, IpAddress.mappedOctets(groups))
    return new IpAddress(6, groups)
  }

  toKey(ipv6Subnet: number): string {
    if (this.version === 4) return this.parts.join('.')
    if (!Number.isInteger(ipv6Subnet) || ipv6Subnet < 0 || ipv6Subnet > IPV6_BITS) {
      throw new RangeError(`ipv6Subnet must be a whole number from 0 to ${IPV6_BITS}`)
    }
    const masked = this.parts.map((group, index) => group & IpAddress.groupMask(ipv6Subnet, index))
    return `${IpAddress.compress(masked)}/${ipv6Subnet}`
  }

  private static stripDecorations(input: string): string {
    const bracketed = BRACKETED.exec(input)?.[1]
    if (bracketed !== undefined) return IpAddress.stripZone(bracketed)
    const ipv4 = IPV4_WITH_PORT.exec(input)?.[1]
    return ipv4 ?? IpAddress.stripZone(input)
  }

  private static stripZone(input: string): string {
    const zoneStart = input.indexOf('%')
    if (zoneStart === -1 || !input.includes(':')) return input
    return input.slice(0, zoneStart)
  }

  private static ipv4Octets(address: string): number[] {
    return address.split('.').map(Number)
  }

  private static expandIpv6(address: string): number[] {
    const [head = '', tail] = IpAddress.withIpv4TailAsHex(address).split('::')
    const headGroups = IpAddress.hexGroups(head)
    if (tail === undefined) return headGroups
    const tailGroups = IpAddress.hexGroups(tail)
    const zeros = new Array<number>(IPV6_GROUP_COUNT - headGroups.length - tailGroups.length).fill(0)
    return [...headGroups, ...zeros, ...tailGroups]
  }

  private static withIpv4TailAsHex(address: string): string {
    const lastColon = address.lastIndexOf(':')
    const tail = address.slice(lastColon + 1)
    if (!tail.includes('.')) return address
    const [a = 0, b = 0, c = 0, d = 0] = IpAddress.ipv4Octets(tail)
    const high = ((a << 8) | b).toString(16)
    const low = ((c << 8) | d).toString(16)
    return `${address.slice(0, lastColon + 1)}${high}:${low}`
  }

  private static hexGroups(text: string): number[] {
    return text === '' ? [] : text.split(':').map((group) => Number.parseInt(group, 16))
  }

  private static isIpv4Mapped(groups: readonly number[]): boolean {
    return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  }

  private static mappedOctets(groups: readonly number[]): number[] {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return [high >> 8, high & 0xff, low >> 8, low & 0xff]
  }

  private static groupMask(prefixLength: number, index: number): number {
    const bits = Math.min(IPV6_GROUP_BITS, Math.max(0, prefixLength - index * IPV6_GROUP_BITS))
    return (0xffff << (IPV6_GROUP_BITS - bits)) & 0xffff
  }

  private static compress(groups: readonly number[]): string {
    const hex = groups.map((group) => group.toString(16))
    const { start, length } = IpAddress.longestZeroRun(groups)
    if (length < 2) return hex.join(':')
    return `${hex.slice(0, start).join(':')}::${hex.slice(start + length).join(':')}`
  }

  private static longestZeroRun(groups: readonly number[]): { start: number; length: number } {
    let best = { start: -1, length: 0 }
    let runStart = -1
    for (const [index, group] of groups.entries()) {
      if (group !== 0) {
        runStart = -1
        continue
      }
      if (runStart === -1) runStart = index
      if (index - runStart + 1 > best.length) best = { start: runStart, length: index - runStart + 1 }
    }
    return best
  }
}
