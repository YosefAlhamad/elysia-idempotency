import { z } from 'zod'
import { type Clock, isClock } from '../core/clock'
import { Duration } from '../core/duration'
import { IdempotencyConfigError } from '../errors'
import { type IdempotencyStore, isIdempotencyStore } from '../stores/store'

const SECOND_MS = 1_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export const idempotencyEngineOptionsShape = {
  store: z.custom<IdempotencyStore>(isIdempotencyStore, 'Expected a store with read(), update() and delete()').optional(),
  prefix: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Prefix must be 1 to 64 letters, digits, "_" or "-"')
    .default('idempotency'),
  retention: Duration.schema({ min: SECOND_MS, max: 30 * DAY_MS }).default(DAY_MS),
  lockTimeout: Duration.schema({ min: SECOND_MS, max: HOUR_MS }).default(60 * SECOND_MS),
  clock: z.custom<Clock>(isClock, 'Expected an object with a now() method').optional(),
}

interface DurationOptions {
  readonly retention: number
  readonly lockTimeout: number
}

export const lockFitsRetention = (options: DurationOptions): boolean => options.lockTimeout <= options.retention

export const LOCK_FITS_RETENTION_ISSUE = {
  path: ['lockTimeout'],
  message: 'lockTimeout must not be longer than retention',
}

export const withDurationsMs = <TOptions extends DurationOptions>({
  retention,
  lockTimeout,
  ...rest
}: TOptions): Omit<TOptions, keyof DurationOptions> & { readonly retentionMs: number; readonly lockTimeoutMs: number } => ({
  ...rest,
  retentionMs: retention,
  lockTimeoutMs: lockTimeout,
})

export const idempotencyEngineOptionsSchema = z
  .strictObject(idempotencyEngineOptionsShape)
  .refine(lockFitsRetention, LOCK_FITS_RETENTION_ISSUE)
  .transform(withDurationsMs)

export type IdempotencyEngineOptions = z.input<typeof idempotencyEngineOptionsSchema>

export const parseOptions = <TOutput>(schema: z.ZodType<TOutput>, options: unknown): TOutput => {
  const result = schema.safeParse(options)
  if (!result.success) throw new IdempotencyConfigError(result.error)
  return result.data
}
