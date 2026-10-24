import { describe, expect, test } from 'bun:test'
import { IdempotencyKey } from '../../src/core/idempotency-key'

const UUID = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b'
const ULID = '01HZX3K9QW8E7R6T5Y4U3I2O1P'
const BASE64URL = 'dGhpcyBpcyBhIGtleQ_-Zm9v'

describe('IdempotencyKey.parse', () => {
  test.each([null, '', ' ', '   ', '\t', ' \t '])('treats %p as missing', (header) => {
    expect(IdempotencyKey.parse(header)).toEqual({ status: 'missing' })
  })

  test.each([UUID, ULID, BASE64URL, 'a', '!', '~', 'key:with#symbols[]{}|^`'])(
    'accepts the unquoted key %p',
    (header) => {
      expect(IdempotencyKey.parse(header)).toEqual({ status: 'valid', value: header })
    },
  )

  test('strips one pair of surrounding quotes', () => {
    expect(IdempotencyKey.parse(`"${UUID}"`)).toEqual({ status: 'valid', value: UUID })
  })

  test('trims whitespace before and after unquoting', () => {
    expect(IdempotencyKey.parse(`  ${UUID}\t`)).toEqual({ status: 'valid', value: UUID })
    expect(IdempotencyKey.parse(` "${UUID}" `)).toEqual({ status: 'valid', value: UUID })
  })

  test('does not trim inside the quotes', () => {
    expect(IdempotencyKey.parse(`" ${UUID}"`)).toEqual({ status: 'invalid' })
  })

  test.each(['""', '"""abc"""', '""abc""', '"abc', 'abc"', 'a"b'])('rejects bad quoting %p', (header) => {
    expect(IdempotencyKey.parse(header)).toEqual({ status: 'invalid' })
  })

  test('accepts exactly 255 characters', () => {
    const key = 'k'.repeat(255)
    expect(IdempotencyKey.parse(key)).toEqual({ status: 'valid', value: key })
    expect(IdempotencyKey.parse(`"${key}"`)).toEqual({ status: 'valid', value: key })
  })

  test('rejects more than 255 characters', () => {
    expect(IdempotencyKey.parse('k'.repeat(256))).toEqual({ status: 'invalid' })
    expect(IdempotencyKey.parse(`"${'k'.repeat(256)}"`)).toEqual({ status: 'invalid' })
  })

  test.each([
    'has space',
    'back\\slash',
    'tab\tinside',
    'new\nline',
    'nul\u0000byte',
    'del\u007f',
    'café',
    'emoji\u{1f511}',
  ])('rejects bad characters in %p', (header) => {
    expect(IdempotencyKey.parse(header)).toEqual({ status: 'invalid' })
  })

  test.each([`${UUID}, ${ULID}`, `${UUID},${ULID}`, `"${UUID}", "${ULID}"`, `"${UUID},${ULID}"`, 'a,', ','])(
    'rejects several values %p',
    (header) => {
      expect(IdempotencyKey.parse(header)).toEqual({ status: 'invalid' })
    },
  )
})
