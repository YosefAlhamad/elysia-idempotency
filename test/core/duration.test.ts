import { describe, expect, test } from 'bun:test'
import { Duration } from '../../src/core/duration'
import { IdempotencyConfigError } from '../../src/errors'

const SECOND_MS = 1_000
const HOUR_MS = 3_600_000
const THIRTY_DAYS_MS = 30 * 86_400_000

const RETENTION_BOUNDS = { min: SECOND_MS, max: THIRTY_DAYS_MS }
const LOCK_BOUNDS = { min: SECOND_MS, max: HOUR_MS }

describe('Duration.toMilliseconds', () => {
  test.each([
    ['1s', 1_000],
    ['1000ms', 1_000],
    ['30s', 30_000],
    ['15m', 900_000],
    ['1h', 3_600_000],
    ['24h', 86_400_000],
    ['1d', 86_400_000],
    ['30d', THIRTY_DAYS_MS],
    ['720h', THIRTY_DAYS_MS],
  ])('parses %p as %p ms', (input, expected) => {
    expect(Duration.toMilliseconds(input, RETENTION_BOUNDS)).toBe(expected)
  })

  test('takes numbers as milliseconds', () => {
    expect(Duration.toMilliseconds(SECOND_MS, RETENTION_BOUNDS)).toBe(SECOND_MS)
    expect(Duration.toMilliseconds(60_000, RETENTION_BOUNDS)).toBe(60_000)
    expect(Duration.toMilliseconds(THIRTY_DAYS_MS, RETENTION_BOUNDS)).toBe(THIRTY_DAYS_MS)
  })

  test('accepts the exact bounds given by the caller', () => {
    expect(Duration.toMilliseconds('1s', LOCK_BOUNDS)).toBe(SECOND_MS)
    expect(Duration.toMilliseconds('1h', LOCK_BOUNDS)).toBe(HOUR_MS)
    expect(Duration.toMilliseconds('60m', LOCK_BOUNDS)).toBe(HOUR_MS)
    expect(Duration.toMilliseconds(1, { min: 1, max: 1 })).toBe(1)
  })

  test.each([0, -1, 999, 1.5, HOUR_MS + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the number %p outside the lock bounds',
    (input) => {
      expect(() => Duration.toMilliseconds(input, LOCK_BOUNDS)).toThrow(IdempotencyConfigError)
    },
  )

  test.each(['0s', '999ms', '61m', '2h', '1d', '3600001ms', '99999999999999999999d'])(
    'rejects the string %p outside the lock bounds',
    (input) => {
      expect(() => Duration.toMilliseconds(input, LOCK_BOUNDS)).toThrow(IdempotencyConfigError)
    },
  )

  test.each(['31d', '721h', '2592000001ms'])('rejects the string %p above the retention bounds', (input) => {
    expect(() => Duration.toMilliseconds(input, RETENTION_BOUNDS)).toThrow(IdempotencyConfigError)
  })

  test.each(['', 'ms', '10', '1.5s', '-1s', ' 1s', '1s ', '1 s', '1S', '1w', '1sec', '1e3ms', 'abc'])(
    'rejects the malformed string %p',
    (input) => {
      expect(() => Duration.toMilliseconds(input, RETENTION_BOUNDS)).toThrow(IdempotencyConfigError)
    },
  )

  test('explains why a string is malformed', () => {
    expect(() => Duration.toMilliseconds('1w', RETENTION_BOUNDS)).toThrow(/Duration must look like/)
  })

  test('explains the bounds in readable units', () => {
    expect(() => Duration.toMilliseconds(0, LOCK_BOUNDS)).toThrow(/at least 1s/)
    expect(() => Duration.toMilliseconds('2h', LOCK_BOUNDS)).toThrow(/at most 1h/)
    expect(() => Duration.toMilliseconds('31d', RETENTION_BOUNDS)).toThrow(/at most 30d/)
    expect(() => Duration.toMilliseconds(1.5, LOCK_BOUNDS)).toThrow(/whole number/)
  })
})

describe('Duration.schema', () => {
  test('returns the bound message as an issue', () => {
    const result = Duration.schema(LOCK_BOUNDS).safeParse('2h')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Duration must be at most 1h')
  })

  test('rejects values that are neither numbers nor strings', () => {
    expect(Duration.schema(LOCK_BOUNDS).safeParse(true).success).toBe(false)
  })
})

describe('Duration.format', () => {
  test.each([
    [1, '1ms'],
    [1_500, '1500ms'],
    [SECOND_MS, '1s'],
    [90_000, '90s'],
    [60_000, '1m'],
    [HOUR_MS, '1h'],
    [THIRTY_DAYS_MS, '30d'],
    [0, '0ms'],
  ])('formats %p as %p', (input, expected) => {
    expect(Duration.format(input)).toBe(expected)
  })
})
