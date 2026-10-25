import { describe, expect, test } from 'bun:test'
import { StoragePolicy, defaultShouldStore } from '../../src/plugin/storage-policy'

describe('defaultShouldStore', () => {
  test.each([200, 201, 204, 301, 400, 402, 404, 422, 499])('stores %i', (status) => {
    expect(defaultShouldStore(status)).toBe(true)
  })

  test.each([408, 409, 425, 429, 500, 502, 503, 599])('keeps %i retryable', (status) => {
    expect(defaultShouldStore(status)).toBe(false)
  })
})

describe('StoragePolicy', () => {
  test.each([0, 101, 199, 600, 200.5])('never stores status %d, whatever shouldStore says', (status) => {
    let asked = false
    const policy = new StoragePolicy(() => ((asked = true), true))
    expect(policy.allows(status)).toBe(false)
    expect(asked).toBe(false)
  })

  test('asks shouldStore inside the range and only accepts true', () => {
    expect(new StoragePolicy(() => true).allows(503)).toBe(true)
    expect(new StoragePolicy(() => 'yes' as unknown as boolean).allows(200)).toBe(false)
  })

  test('releases when shouldStore throws', () => {
    const policy = new StoragePolicy(() => {
      throw new Error('broken policy')
    })
    expect(policy.allows(200)).toBe(false)
  })
})
