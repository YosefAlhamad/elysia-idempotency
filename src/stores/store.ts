export type StoreWrite<TResult> =
  | { readonly action: 'set'; readonly value: string; readonly ttlMs: number; readonly result: TResult }
  | { readonly action: 'delete'; readonly result: TResult }
  | { readonly action: 'keep'; readonly result: TResult }

export type StoreMutation<TResult> = (current: string | null) => StoreWrite<TResult>

export interface IdempotencyStore {
  read(key: string): Promise<string | null>
  update<TResult>(key: string, mutation: StoreMutation<TResult>): Promise<TResult>
  delete(key: string): Promise<void>
  close?(): Promise<void>
}

export const isIdempotencyStore = (value: unknown): value is IdempotencyStore => {
  if (typeof value !== 'object' || value === null) return false
  if (!('read' in value) || typeof value.read !== 'function') return false
  if (!('update' in value) || typeof value.update !== 'function') return false
  if (!('delete' in value) || typeof value.delete !== 'function') return false
  return !('close' in value) || value.close === undefined || typeof value.close === 'function'
}

export const normalizeTtlMs = (ttlMs: number): number => {
  if (!Number.isFinite(ttlMs)) throw new RangeError('Store TTL must be a finite number of milliseconds')
  return Math.max(1, Math.ceil(ttlMs))
}
