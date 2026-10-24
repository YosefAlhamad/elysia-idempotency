import { z } from 'zod'
import { IdempotencyError } from '../errors'
import { type StoredResponse, storedResponseSchema } from './stored-response'

export interface InProgressRecord {
  readonly state: 'in-progress'
  readonly token: string
  readonly fingerprint: string | null
  readonly startedAt: number
}

export interface CompletedRecord {
  readonly state: 'completed'
  readonly fingerprint: string | null
  readonly completedAt: number
  readonly response: StoredResponse
}

export type IdempotencyRecord = InProgressRecord | CompletedRecord

const fingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable()

const timestampSchema = z.number().int().nonnegative()

export const idempotencyRecordSchema: z.ZodType<IdempotencyRecord> = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('in-progress'),
    token: z.uuid(),
    fingerprint: fingerprintSchema,
    startedAt: timestampSchema,
  }),
  z.strictObject({
    state: z.literal('completed'),
    fingerprint: fingerprintSchema,
    completedAt: timestampSchema,
    response: storedResponseSchema,
  }),
])

export const MAX_ENCODED_RECORD_LENGTH = 40 * 1024 * 1024

export class IdempotencyRecordCodec {
  encode(record: IdempotencyRecord): string {
    const result = idempotencyRecordSchema.safeParse(record)
    if (!result.success) throw new IdempotencyError('Idempotency record is invalid', { cause: result.error })
    return JSON.stringify(result.data)
  }

  decode(value: string | null): IdempotencyRecord | null {
    if (value === null || value.length > MAX_ENCODED_RECORD_LENGTH) return null
    const result = idempotencyRecordSchema.safeParse(IdempotencyRecordCodec.parseJson(value))
    return result.success ? result.data : null
  }

  private static parseJson(value: string): unknown {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
}
