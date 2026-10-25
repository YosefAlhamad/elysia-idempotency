import { z } from 'zod'
import { IpAddress } from './ip-address'

export type TrustProxy = boolean | number

export interface RequestAddressSource {
  requestIP(request: Request): { readonly address: string } | null
}

export const trustProxySchema = z.union([z.boolean(), z.number().int().min(1).max(32)])

export class ClientIpResolver {
  private readonly trustProxy: TrustProxy

  constructor(trustProxy: TrustProxy = false) {
    const result = trustProxySchema.safeParse(trustProxy)
    if (!result.success) throw new RangeError('trustProxy must be a boolean or a whole number of hops from 1 to 32')
    this.trustProxy = result.data
  }

  resolve(request: Request, server: RequestAddressSource | null): IpAddress | null {
    const socket = () => ClientIpResolver.socketAddress(request, server)
    if (this.trustProxy === false) return socket()
    const entries = ClientIpResolver.forwardedEntries(request)
    if (this.trustProxy === true) return ClientIpResolver.leftmostValid(entries) ?? socket()
    const entry = entries[entries.length - this.trustProxy]
    return entry === undefined ? socket() : IpAddress.parse(entry)
  }

  private static socketAddress(request: Request, server: RequestAddressSource | null): IpAddress | null {
    const address = server?.requestIP(request)?.address
    return address === undefined ? null : IpAddress.parse(address)
  }

  private static forwardedEntries(request: Request): string[] {
    const header = request.headers.get('x-forwarded-for')
    if (header === null || header.trim() === '') return []
    return header.split(',')
  }

  private static leftmostValid(entries: readonly string[]): IpAddress | null {
    for (const entry of entries) {
      const address = IpAddress.parse(entry)
      if (address !== null) return address
    }
    return null
  }
}
