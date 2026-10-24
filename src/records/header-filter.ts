const ALWAYS_EXCLUDED: ReadonlySet<string> = new Set([
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
])

const EXCLUDED_PREFIX = 'ratelimit'

export const MAX_HEADER_NAME_LENGTH = 256
export const MAX_HEADER_VALUE_LENGTH = 16_384

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/
const HEADER_VALUE_PATTERN = /^[\x01-\x09\x0b\x0c\x0e-\xff]*$/

export class HeaderFilter {
  private readonly excluded: ReadonlySet<string>

  constructor(excludeHeaders: Iterable<string> = []) {
    this.excluded = new Set(Array.from(excludeHeaders, (name) => name.toLowerCase()))
  }

  static isAlwaysExcluded(name: string): boolean {
    const lower = name.toLowerCase()
    return ALWAYS_EXCLUDED.has(lower) || lower.startsWith(EXCLUDED_PREFIX)
  }

  static isStorable(name: string, value: string): boolean {
    if (name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_PATTERN.test(name)) return false
    if (value.length > MAX_HEADER_VALUE_LENGTH || !HEADER_VALUE_PATTERN.test(value)) return false
    return !HeaderFilter.isAlwaysExcluded(name)
  }

  allows(name: string, value: string): boolean {
    return HeaderFilter.isStorable(name, value) && !this.excluded.has(name)
  }
}
