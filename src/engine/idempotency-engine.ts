import { type Clock, SystemClock } from '../core/clock'
import { KeyBuilder } from '../keys/key-builder'
import { FINGERPRINT_PATTERN, type IdempotencyRecord, IdempotencyRecordCodec } from '../records/idempotency-record'
import type { StoredResponse } from '../records/stored-response'
import { MemoryStore } from '../stores/memory-store'
import type { IdempotencyStore, StoreWrite } from '../stores/store'
import type { BeginInput, BeginOutcome, IdempotencyLease } from './begin-outcome'
import { type IdempotencyEngineOptions, idempotencyEngineOptionsSchema, parseOptions } from './engine-schema'

export class IdempotencyEngine {
  private readonly keys: KeyBuilder
  private readonly codec = new IdempotencyRecordCodec()
  private readonly clock: Clock
  private readonly store: IdempotencyStore
  private readonly ownsStore: boolean
  private readonly retentionMs: number
  private readonly lockTimeoutMs: number

  constructor(options: IdempotencyEngineOptions = {}) {
    const settings = parseOptions(idempotencyEngineOptionsSchema, options)
    this.keys = new KeyBuilder(settings.prefix)
    this.clock = settings.clock ?? new SystemClock()
    this.store = settings.store ?? new MemoryStore({ clock: this.clock })
    this.ownsStore = settings.store === undefined
    this.retentionMs = settings.retentionMs
    this.lockTimeoutMs = settings.lockTimeoutMs
  }

  async begin(input: BeginInput): Promise<BeginOutcome> {
    IdempotencyEngine.assertBeginInput(input)
    const storeKey = this.keys.build(input.scope, input.key)
    return this.store.update(storeKey, (current) => this.beginWrite(storeKey, input.fingerprint, this.codec.decode(current)))
  }

  async complete(lease: IdempotencyLease, response: StoredResponse): Promise<boolean> {
    return this.store.update(lease.storeKey, (current) => this.completeWrite(lease, response, this.codec.decode(current)))
  }

  async release(lease: IdempotencyLease): Promise<boolean> {
    return this.store.update(lease.storeKey, (current) => this.releaseWrite(lease, this.codec.decode(current)))
  }

  async close(): Promise<void> {
    if (this.ownsStore) await this.store.close?.()
  }

  private beginWrite(storeKey: string, fingerprint: string | null, record: IdempotencyRecord | null): StoreWrite<BeginOutcome> {
    if (record === null) return this.start(storeKey, fingerprint)
    if (record.state === 'in-progress') return IdempotencyEngine.keep({ kind: 'in-progress' })
    if (IdempotencyEngine.isMismatch(record.fingerprint, fingerprint)) return IdempotencyEngine.keep({ kind: 'mismatch' })
    return IdempotencyEngine.keep({ kind: 'replay', response: record.response })
  }

  private start(storeKey: string, fingerprint: string | null): StoreWrite<BeginOutcome> {
    const token = crypto.randomUUID()
    const value = this.codec.encode({ state: 'in-progress', token, fingerprint, startedAt: this.now() })
    return { action: 'set', value, ttlMs: this.lockTimeoutMs, result: { kind: 'started', lease: { storeKey, token, fingerprint } } }
  }

  private completeWrite(lease: IdempotencyLease, response: StoredResponse, record: IdempotencyRecord | null): StoreWrite<boolean> {
    if (record !== null && !IdempotencyEngine.isHeldBy(record, lease)) return IdempotencyEngine.keep(false)
    const value = this.codec.encode({ state: 'completed', fingerprint: lease.fingerprint, completedAt: this.now(), response })
    return { action: 'set', value, ttlMs: this.retentionMs, result: true }
  }

  private releaseWrite(lease: IdempotencyLease, record: IdempotencyRecord | null): StoreWrite<boolean> {
    if (record === null || !IdempotencyEngine.isHeldBy(record, lease)) return IdempotencyEngine.keep(false)
    return { action: 'delete', result: true }
  }

  private now(): number {
    return Math.floor(this.clock.now())
  }

  private static isHeldBy(record: IdempotencyRecord, lease: IdempotencyLease): boolean {
    return record.state === 'in-progress' && record.token === lease.token
  }

  private static isMismatch(stored: string | null, incoming: string | null): boolean {
    return stored !== null && incoming !== null && stored !== incoming
  }

  private static keep<TResult>(result: TResult): StoreWrite<TResult> {
    return { action: 'keep', result }
  }

  private static assertBeginInput(input: BeginInput): void {
    if (typeof input.scope !== 'string') throw new TypeError('Idempotency scope must be a string')
    if (typeof input.key !== 'string' || input.key.length === 0) throw new TypeError('Idempotency key must be a non-empty string')
    if (input.fingerprint === null || FINGERPRINT_PATTERN.test(input.fingerprint)) return
    throw new TypeError('Idempotency fingerprint must be 64 lowercase hex characters or null')
  }
}
