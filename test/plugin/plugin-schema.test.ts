import { describe, expect, test } from 'bun:test'
import { IdempotencyConfigError } from '../../src/errors'
import { idempotency } from '../../src/plugin/idempotency-plugin'
import {
  type IdempotencyElysiaContext,
  type IdempotencyRequestContext,
  defaultIdentity,
  idempotencyPluginOptionsSchema,
} from '../../src/plugin/plugin-schema'
import { defaultShouldStore } from '../../src/plugin/storage-policy'

const contextFor = (headers: Record<string, string>, ip: string | null): IdempotencyRequestContext => {
  const request = new Request('http://localhost/', { headers })
  return { request, path: '/', ip, elysia: {} as IdempotencyElysiaContext }
}

const configErrorFor = (options: unknown): IdempotencyConfigError => {
  try {
    idempotency(options as Parameters<typeof idempotency>[0])
  } catch (error) {
    if (error instanceof IdempotencyConfigError) return error
    throw error
  }
  throw new Error('Expected idempotency() to throw')
}

describe('idempotencyPluginOptionsSchema defaults', () => {
  test('fills every option with its documented default', () => {
    const settings = idempotencyPluginOptionsSchema.parse({})
    expect(settings.prefix).toBe('idempotency')
    expect(settings.retentionMs).toBe(86_400_000)
    expect(settings.lockTimeoutMs).toBe(60_000)
    expect(settings.header).toBe('Idempotency-Key')
    expect([...settings.methods]).toEqual(['POST', 'PATCH'])
    expect(settings.required).toBe(false)
    expect(settings.fingerprint).toBe(true)
    expect(settings.identity).toBe(defaultIdentity)
    expect(settings.trustProxy).toBe(false)
    expect(settings.ipv6Subnet).toBe(56)
    expect(settings.maxBodyBytes).toBe(1024 * 1024)
    expect(settings.shouldStore).toBe(defaultShouldStore)
    expect(settings.excludeHeaders).toEqual([])
    expect(settings.failureMode).toBe('closed')
    expect(settings.onRejected).toBeUndefined()
    expect(settings.scope).toBe('scoped')
  })

  test('uppercases methods and lowercases excluded headers', () => {
    const settings = idempotencyPluginOptionsSchema.parse({ methods: ['post', 'Put'], excludeHeaders: ['X-Trace-Id'] })
    expect([...settings.methods]).toEqual(['POST', 'PUT'])
    expect(settings.excludeHeaders).toEqual(['x-trace-id'])
  })
})

describe('idempotency() config errors', () => {
  test.each<[string, Record<string, unknown>]>([
    ['header', { header: 'Idempotency Key' }],
    ['header', { header: '' }],
    ['methods', { methods: ['GET'] }],
    ['methods', { methods: ['post', 'POST'] }],
    ['methods', { methods: [] }],
    ['methods', { methods: ['PO ST'] }],
    ['required', { required: 'yes' }],
    ['fingerprint', { fingerprint: 'body' }],
    ['identity', { identity: 'user' }],
    ['trustProxy', { trustProxy: 0 }],
    ['ipv6Subnet', { ipv6Subnet: 129 }],
    ['maxBodyBytes', { maxBodyBytes: -1 }],
    ['maxBodyBytes', { maxBodyBytes: 16 * 1024 * 1024 + 1 }],
    ['shouldStore', { shouldStore: true }],
    ['excludeHeaders', { excludeHeaders: ['bad header'] }],
    ['failureMode', { failureMode: 'ignore' }],
    ['onRejected', { onRejected: {} }],
    ['scope', { scope: 'route' }],
    ['retention', { retention: 'forever' }],
    ['lockTimeout', { retention: '1m', lockTimeout: '1h' }],
    ['prefix', { prefix: 'has:colon' }],
    ['store', { store: {} }],
    ['clock', { clock: {} }],
    ['requried', { requried: true }],
  ])('throws at setup naming the bad field %s', (field, options) => {
    const error = configErrorFor(options)
    expect(error.name).toBe('IdempotencyConfigError')
    expect(error.message).toContain(field)
  })

  test('rejects safe methods in any case', () => {
    expect(configErrorFor({ methods: ['options'] }).message).toContain('GET, HEAD or OPTIONS')
  })
})

describe('defaultIdentity', () => {
  test('prefers the Authorization header', () => {
    expect(defaultIdentity(contextFor({ authorization: 'Bearer t' }, '10.0.0.1'))).toBe('auth:Bearer t')
  })

  test('falls back to the client IP', () => {
    expect(defaultIdentity(contextFor({}, '10.0.0.1'))).toBe('ip:10.0.0.1')
  })

  test('is anonymous without either', () => {
    expect(defaultIdentity(contextFor({}, null))).toBe('anonymous')
  })
})
