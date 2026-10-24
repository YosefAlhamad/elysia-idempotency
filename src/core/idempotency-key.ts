export type IdempotencyKeyResult =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'valid'; readonly value: string }

const KEY_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,255}$/

const MISSING: IdempotencyKeyResult = { status: 'missing' }
const INVALID: IdempotencyKeyResult = { status: 'invalid' }

export class IdempotencyKey {
  static parse(header: string | null): IdempotencyKeyResult {
    if (header === null) return MISSING
    const trimmed = header.trim()
    if (trimmed.length === 0) return MISSING
    if (trimmed.includes(',')) return INVALID
    const value = IdempotencyKey.unquote(trimmed)
    if (!KEY_PATTERN.test(value)) return INVALID
    return { status: 'valid', value }
  }

  private static unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
    return value
  }
}
