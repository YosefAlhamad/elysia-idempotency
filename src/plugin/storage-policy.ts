import { MAX_STORED_STATUS, MIN_STORED_STATUS } from '../records/stored-response'

const SERVER_ERROR_STATUS = 500

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 409, 425, 429])

export type ShouldStore = (status: number) => boolean

export const defaultShouldStore: ShouldStore = (status) => status < SERVER_ERROR_STATUS && !RETRYABLE_STATUSES.has(status)

export class StoragePolicy {
  constructor(private readonly shouldStore: ShouldStore) {}

  allows(status: number): boolean {
    if (!Number.isInteger(status) || status < MIN_STORED_STATUS || status > MAX_STORED_STATUS) return false
    try {
      return this.shouldStore(status) === true
    } catch {
      return false
    }
  }
}
