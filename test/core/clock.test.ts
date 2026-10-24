import { describe, expect, test } from 'bun:test'
import { SystemClock, isClock } from '../../src/core/clock'
import { ManualClock } from '../helpers/manual-clock'

describe('SystemClock', () => {
  test('returns the current Unix time in milliseconds', () => {
    const before = Date.now()
    const now = new SystemClock().now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe('isClock', () => {
  test('accepts objects with a now function', () => {
    expect(isClock(new SystemClock())).toBe(true)
    expect(isClock(new ManualClock())).toBe(true)
    expect(isClock({ now: () => 0 })).toBe(true)
  })

  test.each([null, undefined, 0, 'clock', {}, { now: 0 }, () => 0])('rejects %p', (value) => {
    expect(isClock(value)).toBe(false)
  })
})

describe('ManualClock', () => {
  test('starts at the given time, then sets and advances', () => {
    const clock = new ManualClock(1_000)
    expect(clock.now()).toBe(1_000)
    clock.advance(250)
    expect(clock.now()).toBe(1_250)
    clock.set(10)
    expect(clock.now()).toBe(10)
  })

  test('starts at zero by default', () => {
    expect(new ManualClock().now()).toBe(0)
  })
})
