import { describe, expect, spyOn, test } from 'bun:test'
import { IdempotencyError } from '../../src/errors'
import { MAX_HEADER_VALUE_LENGTH } from '../../src/records/header-filter'
import {
  type CompletedRecord,
  type IdempotencyRecord,
  type InProgressRecord,
  IdempotencyRecordCodec,
  MAX_ENCODED_RECORD_LENGTH,
  idempotencyRecordSchema,
} from '../../src/records/idempotency-record'
import { MAX_STORED_BODY_BYTES, MAX_STORED_HEADERS } from '../../src/records/stored-response'

const FINGERPRINT = 'a'.repeat(64)

const inProgress: InProgressRecord = {
  state: 'in-progress',
  token: crypto.randomUUID(),
  fingerprint: FINGERPRINT,
  startedAt: 1_700_000_000_000,
}

const completed: CompletedRecord = {
  state: 'completed',
  fingerprint: null,
  completedAt: 1_700_000_005_000,
  response: {
    status: 201,
    headers: [
      ['content-type', 'application/json'],
      ['location', '/payments/1'],
    ],
    body: Buffer.from('{"id":1}').toString('base64'),
    bodyOmitted: false,
  },
}

const codec = new IdempotencyRecordCodec()

const withChanges = (record: object, changes: Record<string, unknown>) => JSON.stringify({ ...record, ...changes })

const withResponseChanges = (changes: Record<string, unknown>) =>
  withChanges(completed, { response: { ...completed.response, ...changes } })

describe('IdempotencyRecordCodec', () => {
  test('round trips an in-progress record', () => {
    expect(codec.decode(codec.encode(inProgress))).toEqual(inProgress)
  })

  test('round trips a completed record', () => {
    expect(codec.decode(codec.encode(completed))).toEqual(completed)
  })

  test('round trips a completed record with an omitted body', () => {
    const record: CompletedRecord = {
      ...completed,
      response: { status: 200, headers: [], body: null, bodyOmitted: true },
    }
    expect(codec.decode(codec.encode(record))).toEqual(record)
  })

  test('encodes as JSON', () => {
    expect(JSON.parse(codec.encode(inProgress))).toEqual(inProgress)
  })

  test('decodes a missing value as no record', () => {
    expect(codec.decode(null)).toBeNull()
  })

  test.each(['', '{', 'not json', '{"state":', 'undefined', '\u0000'])('decodes corrupt JSON %p as no record', (value) => {
    expect(codec.decode(value)).toBeNull()
  })

  test.each(['null', '1', '"completed"', '[]', 'true', '{}'])('decodes the non-record JSON %p as no record', (value) => {
    expect(codec.decode(value)).toBeNull()
  })

  test.each([
    ['an unknown state', withChanges(inProgress, { state: 'done' })],
    ['a non-uuid token', withChanges(inProgress, { token: 'abc' })],
    ['a missing token', withChanges(inProgress, { token: undefined })],
    ['an uppercase fingerprint', withChanges(inProgress, { fingerprint: 'A'.repeat(64) })],
    ['a short fingerprint', withChanges(inProgress, { fingerprint: 'a'.repeat(63) })],
    ['a negative time', withChanges(inProgress, { startedAt: -1 })],
    ['a fractional time', withChanges(inProgress, { startedAt: 1.5 })],
    ['a string time', withChanges(inProgress, { startedAt: '1' })],
    ['an unsafe integer time', withChanges(inProgress, { startedAt: 2 ** 53 })],
    ['an extra key', withChanges(inProgress, { extra: true })],
    ['a completed field on in-progress', withChanges(inProgress, { completedAt: 1 })],
    ['a missing response', withChanges(completed, { response: undefined })],
    ['a status below 200', withResponseChanges({ status: 101 })],
    ['a status above 599', withResponseChanges({ status: 600 })],
    ['a fractional status', withResponseChanges({ status: 200.5 })],
    ['a non-base64 body', withResponseChanges({ body: 'not base64!' })],
    ['an omitted body with data', withResponseChanges({ bodyOmitted: true })],
    ['an uppercase header name', withResponseChanges({ headers: [['Content-Type', 'text/plain']] })],
    ['a header with a newline', withResponseChanges({ headers: [['x-a', 'a\r\nset-cookie: s=1']] })],
    ['a header with a NUL byte', withResponseChanges({ headers: [['x-a', 'a\u0000b']] })],
    ['a header outside Latin-1', withResponseChanges({ headers: [['x-a', '\u{1f511}']] })],
    ['a stored set-cookie header', withResponseChanges({ headers: [['set-cookie', 's=1']] })],
    ['a stored authorization header', withResponseChanges({ headers: [['authorization', 'Bearer x']] })],
    ['a header with three parts', withResponseChanges({ headers: [['x-a', 'b', 'c']] })],
    ['too many headers', withResponseChanges({ headers: Array.from({ length: 101 }, (_, i) => [`x-h${i}`, 'v']) })],
    ['an extra response key', withResponseChanges({ extra: 1 })],
  ])('decodes %s as no record', (_, value) => {
    expect(codec.decode(value)).toBeNull()
  })

  test('decodes a __proto__ key as no record', () => {
    expect(codec.decode(codec.encode(inProgress).replace('{', '{"__proto__":{"state":"completed"},'))).toBeNull()
  })

  test('decodes a value over the size limit as no record without parsing it', () => {
    const parse = spyOn(JSON, 'parse')
    expect(codec.decode(' '.repeat(MAX_ENCODED_RECORD_LENGTH + 1))).toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  test('decodes an oversized header value as no record', () => {
    const headers = [['x-a', 'v'.repeat(MAX_HEADER_VALUE_LENGTH + 1)]]
    expect(codec.decode(withResponseChanges({ headers }))).toBeNull()
  })

  test('accepts exactly 100 headers', () => {
    const headers = Array.from({ length: 100 }, (_, i) => [`x-h${i}`, 'v'])
    expect(codec.decode(withResponseChanges({ headers }))).not.toBeNull()
  })

  test('accepts an empty base64 body', () => {
    expect(codec.decode(withResponseChanges({ body: '' }))).not.toBeNull()
  })
})

describe('IdempotencyRecordCodec.encode', () => {
  const invalidRecords: ReadonlyArray<readonly [string, unknown]> = [
    ['a non-uuid token', { ...inProgress, token: 'abc' }],
    ['an extra key', { ...inProgress, extra: true }],
    ['a status of 0', { ...completed, response: { ...completed.response, status: 0 } }],
    ['a status of 101', { ...completed, response: { ...completed.response, status: 101 } }],
    ['a stored set-cookie header', { ...completed, response: { ...completed.response, headers: [['set-cookie', 's=1']] } }],
    ['an omitted body with data', { ...completed, response: { ...completed.response, bodyOmitted: true } }],
  ]

  test.each(invalidRecords)('throws an IdempotencyError for %s', (_, record) => {
    const encode = () => codec.encode(record as IdempotencyRecord)
    expect(encode).toThrow(IdempotencyError)
    expect(encode).toThrow('Idempotency record is invalid')
  })

  test('keeps the details out of the message', () => {
    try {
      codec.encode({ ...inProgress, token: 'secret-token' })
      throw new Error('expected encode to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(IdempotencyError)
      expect(String(error)).not.toContain('secret-token')
    }
  })

  test('encodes the largest valid record under the decode limit', () => {
    const value = '\u0001'.repeat(MAX_HEADER_VALUE_LENGTH)
    const record: CompletedRecord = {
      ...completed,
      response: {
        status: 200,
        headers: Array.from({ length: MAX_STORED_HEADERS }, (_, i) => [`x-${'h'.repeat(250)}${i}`, value] as const),
        body: Buffer.alloc(MAX_STORED_BODY_BYTES, 255).toString('base64'),
        bodyOmitted: false,
      },
    }
    const encoded = codec.encode(record)
    expect(encoded.length).toBeLessThanOrEqual(MAX_ENCODED_RECORD_LENGTH)
    expect(codec.decode(encoded)).toEqual(record)
  })
})

describe('idempotencyRecordSchema', () => {
  test('is a discriminated union on state', () => {
    expect(idempotencyRecordSchema.safeParse(inProgress).success).toBe(true)
    expect(idempotencyRecordSchema.safeParse(completed).success).toBe(true)
    expect(idempotencyRecordSchema.safeParse({ ...inProgress, state: 'completed' }).success).toBe(false)
  })
})
