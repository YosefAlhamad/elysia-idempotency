export interface Clock {
  now(): number
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

export const isClock = (value: unknown): value is Clock =>
  typeof value === 'object' && value !== null && 'now' in value && typeof value.now === 'function'
