import type { Context } from 'elysia'
import { z } from 'zod'
import {
  LOCK_FITS_RETENTION_ISSUE,
  idempotencyEngineOptionsShape,
  lockFitsRetention,
  withDurationsMs,
} from '../engine/engine-schema'
import { trustProxySchema } from '../keys/client-ip-resolver'
import { MAX_STORED_BODY_BYTES } from '../records/stored-response'
import type { IdempotencyRejection } from './rejection-response'
import { type ShouldStore, defaultShouldStore } from './storage-policy'

export type IdempotencyElysiaContext = Context<{ params: Record<string, string | undefined> }>

export interface IdempotencyRequestContext {
  readonly request: Request
  readonly path: string
  readonly ip: string | null
  readonly elysia: IdempotencyElysiaContext
}

type MaybePromise<TValue> = TValue | Promise<TValue>

export type IdempotencyIdentityFunction = (context: IdempotencyRequestContext) => MaybePromise<string>
export type IdempotencyFingerprintFunction = (context: IdempotencyRequestContext) => MaybePromise<string>
export type IdempotencyRejectedHandler = (context: IdempotencyRequestContext, rejection: IdempotencyRejection) => unknown

export const defaultIdentity: IdempotencyIdentityFunction = ({ request, ip }) => {
  const authorization = request.headers.get('authorization')
  if (authorization !== null) return `auth:${authorization}`
  if (ip !== null) return `ip:${ip}`
  return 'anonymous'
}

const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])
const MAX_METHODS = 32
const MAX_EXCLUDED_HEADERS = 100
const MEBIBYTE = 1024 * 1024

const isFunction = (value: unknown): boolean => typeof value === 'function'

const functionOption = <TFunction>() => z.custom<TFunction>(isFunction, 'Expected a function')

const headerNameSchema = z.string().regex(HEADER_TOKEN_PATTERN, 'Expected a valid HTTP header name')

const hasNoDuplicates = (values: readonly string[]): boolean => new Set(values).size === values.length

const methodsSchema = z
  .array(z.string().regex(HEADER_TOKEN_PATTERN, 'Expected an HTTP method name'))
  .min(1, 'List at least one method')
  .max(MAX_METHODS)
  .transform((methods) => methods.map((method) => method.toUpperCase()))
  .refine(hasNoDuplicates, 'Methods must not repeat')
  .refine((methods) => methods.every((method) => !SAFE_METHODS.has(method)), 'Methods must not include GET, HEAD or OPTIONS')
  .transform((methods): ReadonlySet<string> => new Set(methods))

const excludeHeadersSchema = z
  .array(headerNameSchema)
  .max(MAX_EXCLUDED_HEADERS)
  .transform((names): readonly string[] => names.map((name) => name.toLowerCase()))

export const idempotencyPluginOptionsSchema = z
  .strictObject({
    ...idempotencyEngineOptionsShape,
    header: headerNameSchema.default('Idempotency-Key'),
    methods: methodsSchema.prefault(['POST', 'PATCH']),
    required: z.boolean().default(false),
    fingerprint: z.union([z.boolean(), functionOption<IdempotencyFingerprintFunction>()]).default(true),
    identity: functionOption<IdempotencyIdentityFunction>().default(() => defaultIdentity),
    trustProxy: trustProxySchema.default(false),
    ipv6Subnet: z.number().int().min(0).max(128).default(56),
    maxBodyBytes: z.number().int().min(0).max(MAX_STORED_BODY_BYTES).default(MEBIBYTE),
    shouldStore: functionOption<ShouldStore>().default(() => defaultShouldStore),
    excludeHeaders: excludeHeadersSchema.default([]),
    failureMode: z.enum(['open', 'closed']).default('closed'),
    onRejected: functionOption<IdempotencyRejectedHandler>().optional(),
    scope: z.enum(['global', 'scoped', 'local']).default('scoped'),
  })
  .refine(lockFitsRetention, LOCK_FITS_RETENTION_ISSUE)
  .transform(withDurationsMs)

export type IdempotencyPluginOptions = z.input<typeof idempotencyPluginOptionsSchema>

export type IdempotencyPluginSettings = z.output<typeof idempotencyPluginOptionsSchema>
