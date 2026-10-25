import type { IdempotencyRejectedHandler, IdempotencyRequestContext } from './plugin-schema'

export type IdempotencyRejection =
  | { readonly reason: 'missing-key'; readonly status: 400 }
  | { readonly reason: 'invalid-key'; readonly status: 400 }
  | { readonly reason: 'in-progress'; readonly status: 409 }
  | { readonly reason: 'mismatch'; readonly status: 422 }
  | { readonly reason: 'unavailable'; readonly status: 503 }

export const REJECTIONS = {
  missingKey: { reason: 'missing-key', status: 400 },
  invalidKey: { reason: 'invalid-key', status: 400 },
  inProgress: { reason: 'in-progress', status: 409 },
  mismatch: { reason: 'mismatch', status: 422 },
  unavailable: { reason: 'unavailable', status: 503 },
} as const satisfies Record<string, IdempotencyRejection>

const MESSAGES = new Map<IdempotencyRejection['reason'], string>([
  ['missing-key', 'Idempotency-Key header is required'],
  ['invalid-key', 'Idempotency-Key header is invalid'],
  ['in-progress', 'A request with this Idempotency-Key is still in progress'],
  ['mismatch', 'Idempotency-Key was already used with a different request'],
  ['unavailable', 'Idempotency is temporarily unavailable'],
])

const RETRY_LATER_STATUSES: ReadonlySet<number> = new Set([409, 503])
const RETRY_AFTER_SECONDS = '1'

export class RejectionResponse {
  constructor(private readonly onRejected: IdempotencyRejectedHandler | undefined) {}

  static defaultBody(rejection: IdempotencyRejection): { readonly error: string } {
    return { error: MESSAGES.get(rejection.reason) ?? 'Idempotency-Key request was rejected' }
  }

  async respond(context: IdempotencyRequestContext, rejection: IdempotencyRejection): Promise<unknown> {
    const { set } = context.elysia
    set.status = rejection.status
    if (RETRY_LATER_STATUSES.has(rejection.status)) set.headers['retry-after'] = RETRY_AFTER_SECONDS
    const custom = await this.customBody(context, rejection)
    return custom ?? RejectionResponse.defaultBody(rejection)
  }

  private async customBody(context: IdempotencyRequestContext, rejection: IdempotencyRejection): Promise<unknown> {
    if (this.onRejected === undefined) return undefined
    try {
      return await this.onRejected(context, rejection)
    } catch {
      return undefined
    }
  }
}
