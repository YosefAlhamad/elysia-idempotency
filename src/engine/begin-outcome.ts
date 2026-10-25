import type { StoredResponse } from '../records/stored-response'

export interface IdempotencyLease {
  readonly storeKey: string
  readonly token: string
  readonly fingerprint: string | null
}

export interface BeginInput {
  readonly scope: string
  readonly key: string
  readonly fingerprint: string | null
}

export type BeginOutcome =
  | { readonly kind: 'started'; readonly lease: IdempotencyLease }
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'mismatch' }
