import type { Clock } from '../../src/core/clock'

export class ManualClock implements Clock {
  private current: number

  constructor(start = 0) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  set(ms: number): void {
    this.current = ms
  }

  advance(ms: number): void {
    this.current += ms
  }
}
