import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  IdempotencyConfigError,
  IdempotencyError,
  StoreConflictError,
  StoreUnavailableError,
} from '../src/errors'

const zodErrorFor = (input: unknown) => {
  const schema = z.object({
    prefix: z.string().min(1),
    nested: z.object({ lockTimeout: z.number() }),
  })
  const result = schema.safeParse(input)
  if (result.success) throw new Error('expected the input to be invalid')
  return result.error
}

describe('IdempotencyError', () => {
  test('is an Error with its own name', () => {
    const error = new IdempotencyError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('IdempotencyError')
    expect(error.message).toBe('boom')
  })
})

describe('IdempotencyConfigError', () => {
  test('extends IdempotencyError and sets its name', () => {
    const error = new IdempotencyConfigError(zodErrorFor({ prefix: '', nested: { lockTimeout: 1 } }))
    expect(error).toBeInstanceOf(IdempotencyError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('IdempotencyConfigError')
  })

  test('keeps the ZodError as cause', () => {
    const zodError = zodErrorFor({ prefix: '', nested: { lockTimeout: 1 } })
    const error = new IdempotencyConfigError(zodError)
    expect(error.cause).toBe(zodError)
  })

  test('names every bad field on its own line', () => {
    const error = new IdempotencyConfigError(zodErrorFor({ prefix: '', nested: { lockTimeout: 'soon' } }))
    const lines = error.message.split('\n')
    expect(lines[0]).toBe('Invalid idempotency options:')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toStartWith('prefix: ')
    expect(lines[2]).toStartWith('nested.lockTimeout: ')
  })

  test('omits the path for root issues', () => {
    const result = z.string().safeParse(5)
    if (result.success) throw new Error('expected the input to be invalid')
    const error = new IdempotencyConfigError(result.error)
    const lines = error.message.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(result.error.issues[0]?.message ?? '')
  })

  test('names unknown keys from a strict object', () => {
    const result = z.strictObject({ retention: z.string() }).safeParse({ retention: '1h', retension: '1h' })
    if (result.success) throw new Error('expected the input to be invalid')
    expect(new IdempotencyConfigError(result.error).message).toContain('retension')
  })
})

describe('store errors', () => {
  test('StoreConflictError extends IdempotencyError and sets its name', () => {
    const error = new StoreConflictError('conflict')
    expect(error).toBeInstanceOf(IdempotencyError)
    expect(error.name).toBe('StoreConflictError')
    expect(error.message).toBe('conflict')
  })

  test('StoreUnavailableError extends IdempotencyError, sets its name and keeps its cause', () => {
    const cause = new Error('connection refused')
    const error = new StoreUnavailableError('unavailable', { cause })
    expect(error).toBeInstanceOf(IdempotencyError)
    expect(error.name).toBe('StoreUnavailableError')
    expect(error.cause).toBe(cause)
  })
})
