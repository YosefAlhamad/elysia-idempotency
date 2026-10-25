import { z } from 'zod'
import { type Clock, SystemClock, isClock } from '../core/clock'
import { IdempotencyConfigError, StoreUnavailableError } from '../errors'
import { type IdempotencyStore, type StoreMutation, type StoreWrite, normalizeTtlMs } from './store'

export interface MemoryStoreOptions {
  readonly maxKeys?: number
  readonly maxBytes?: number
  readonly sweepIntervalMs?: number
  readonly clock?: Clock
}

interface MemoryEntry {
  readonly value: string
  readonly expiresAt: number
  readonly bytes: number
}

const memoryStoreOptionsSchema = z.strictObject({
  maxKeys: z.number().int().positive().max(100_000_000).default(10_000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 ** 3)
    .default(64 * 1024 ** 2),
  sweepIntervalMs: z.number().int().positive().max(86_400_000).default(60_000),
  clock: z.custom<Clock>(isClock, 'Expected an object with a now() method').optional(),
})

export class MemoryStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>()
  private readonly maxKeys: number
  private readonly maxBytes: number
  private readonly clock: Clock
  private readonly sweepTimer: ReturnType<typeof setInterval>
  private usedBytes = 0

  constructor(options: MemoryStoreOptions = {}) {
    const result = memoryStoreOptionsSchema.safeParse(options)
    if (!result.success) throw new IdempotencyConfigError(result.error)
    this.maxKeys = result.data.maxKeys
    this.maxBytes = result.data.maxBytes
    this.clock = result.data.clock ?? new SystemClock()
    this.sweepTimer = setInterval(() => this.sweep(), result.data.sweepIntervalMs)
    this.sweepTimer.unref()
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.usedBytes
  }

  async read(key: string): Promise<string | null> {
    return this.readEntry(key)
  }

  async update<TResult>(key: string, mutation: StoreMutation<TResult>): Promise<TResult> {
    const write = mutation(this.readEntry(key))
    this.apply(key, write)
    return write.result
  }

  async delete(key: string): Promise<void> {
    this.remove(key)
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer)
    this.entries.clear()
    this.usedBytes = 0
  }

  private readEntry(key: string): string | null {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    if (this.isExpired(entry, this.clock.now())) {
      this.remove(key)
      return null
    }
    return entry.value
  }

  private apply<TResult>(key: string, write: StoreWrite<TResult>): void {
    if (write.action === 'keep') return
    if (write.action === 'delete') {
      this.remove(key)
      return
    }
    this.set(key, write.value, write.ttlMs)
  }

  private set(key: string, value: string, ttlMs: number): void {
    const expiresAt = this.clock.now() + normalizeTtlMs(ttlMs)
    const bytes = key.length + value.length
    this.makeRoom(key, bytes)
    this.remove(key)
    this.entries.set(key, { value, expiresAt, bytes })
    this.usedBytes += bytes
  }

  private makeRoom(key: string, bytes: number): void {
    const now = this.clock.now()
    while (!this.fits(key, bytes)) {
      const oldest = this.entries.entries().next()
      if (oldest.done === true || !this.isExpired(oldest.value[1], now)) throw new StoreUnavailableError('Idempotency store is full')
      this.remove(oldest.value[0])
    }
  }

  private fits(key: string, bytes: number): boolean {
    const replaced = this.entries.get(key)
    const keys = this.entries.size + (replaced === undefined ? 1 : 0)
    const total = this.usedBytes - (replaced?.bytes ?? 0) + bytes
    return keys <= this.maxKeys && total <= this.maxBytes
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.usedBytes -= entry.bytes
  }

  private sweep(): void {
    const now = this.clock.now()
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) this.remove(key)
    }
  }

  private isExpired(entry: MemoryEntry, now: number): boolean {
    return entry.expiresAt <= now
  }
}
