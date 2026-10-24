import { z } from 'zod'
import { IdempotencyConfigError } from '../errors'

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/

const UNIT_MILLISECONDS = new Map<string, number>([
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
  ['ms', 1],
])

export interface DurationBounds {
  readonly min: number
  readonly max: number
}

export class Duration {
  static schema(bounds: DurationBounds): z.ZodType<number, number | string> {
    const milliseconds = Duration.millisecondsSchema(bounds)
    const text = Duration.textSchema(milliseconds)
    return z.union([z.number(), z.string()]).transform((input, context) => {
      const result = (typeof input === 'number' ? milliseconds : text).safeParse(input)
      if (result.success) return result.data
      for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message })
      return z.NEVER
    })
  }

  static toMilliseconds(input: number | string, bounds: DurationBounds): number {
    const result = Duration.schema(bounds).safeParse(input)
    if (!result.success) throw new IdempotencyConfigError(result.error)
    return result.data
  }

  static format(ms: number): string {
    for (const [unit, size] of UNIT_MILLISECONDS) {
      if (ms >= size && ms % size === 0) return `${ms / size}${unit}`
    }
    return `${ms}ms`
  }

  private static millisecondsSchema(bounds: DurationBounds): z.ZodType<number, number> {
    return z
      .number()
      .int('Duration must be a whole number of milliseconds')
      .min(bounds.min, `Duration must be at least ${Duration.format(bounds.min)}`)
      .max(bounds.max, `Duration must be at most ${Duration.format(bounds.max)}`)
  }

  private static textSchema(milliseconds: z.ZodType<number, number>): z.ZodType<number, string> {
    return z
      .string()
      .regex(DURATION_PATTERN, 'Duration must look like "500ms", "30s", "15m", "1h" or "1d"')
      .transform((text) => Duration.parseText(text))
      .pipe(milliseconds)
  }

  private static parseText(text: string): number {
    const match = DURATION_PATTERN.exec(text)
    const amount = match?.[1]
    const unit = match?.[2]
    if (amount === undefined || unit === undefined) return Number.NaN
    return Number(amount) * (UNIT_MILLISECONDS.get(unit) ?? Number.NaN)
  }
}
