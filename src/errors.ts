import type { ZodError } from 'zod'

export class IdempotencyError extends Error {
  override readonly name: string = 'IdempotencyError'
}

export class IdempotencyConfigError extends IdempotencyError {
  override readonly name: string = 'IdempotencyConfigError'

  constructor(error: ZodError) {
    super(IdempotencyConfigError.describe(error), { cause: error })
  }

  private static describe(error: ZodError): string {
    const lines = error.issues.map((issue) => {
      const path = issue.path.map(String).join('.')
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    return ['Invalid idempotency options:', ...lines].join('\n')
  }
}

export class StoreConflictError extends IdempotencyError {
  override readonly name: string = 'StoreConflictError'
}

export class StoreUnavailableError extends IdempotencyError {
  override readonly name: string = 'StoreUnavailableError'
}
