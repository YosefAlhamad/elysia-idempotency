import { z } from 'zod'
import { HeaderFilter } from './header-filter'

export interface StoredResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
  readonly bodyOmitted: boolean
}

export interface CaptureOptions {
  readonly maxBodyBytes: number
  readonly headerFilter: HeaderFilter
}

export const MAX_STORED_HEADERS = 100
export const MAX_STORED_BODY_BYTES = 16 * 1024 * 1024

export const MIN_STORED_STATUS = 200
export const MAX_STORED_STATUS = 599

const MAX_ENCODED_BODY_LENGTH = Math.ceil(MAX_STORED_BODY_BYTES / 3) * 4
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])
const EVENT_STREAM = 'text/event-stream'
const REPLAYED_HEADER = 'idempotent-replayed'

const storedHeaderSchema = z
  .tuple([z.string(), z.string()])
  .refine(([name, value]) => HeaderFilter.isStorable(name, value))

export const storedResponseSchema: z.ZodType<StoredResponse> = z
  .strictObject({
    status: z.number().int().min(MIN_STORED_STATUS).max(MAX_STORED_STATUS),
    headers: z.array(storedHeaderSchema).max(MAX_STORED_HEADERS),
    body: z.base64().max(MAX_ENCODED_BODY_LENGTH).nullable(),
    bodyOmitted: z.boolean(),
  })
  .refine((response) => !response.bodyOmitted || response.body === null)

interface ChunkReader {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>
  cancel(): Promise<void>
}

interface CapturedBody {
  readonly body: string | null
  readonly bodyOmitted: boolean
}

const NO_BODY: CapturedBody = { body: null, bodyOmitted: false }
const OMITTED_BODY: CapturedBody = { body: null, bodyOmitted: true }

export class ResponseSnapshot {
  static async capture(response: Response, options: CaptureOptions): Promise<StoredResponse> {
    const captured = await ResponseSnapshot.captureBody(response, options.maxBodyBytes)
    return {
      status: response.status,
      headers: ResponseSnapshot.captureHeaders(response.headers, options.headerFilter),
      body: captured.body,
      bodyOmitted: captured.bodyOmitted,
    }
  }

  static toResponse(stored: StoredResponse): Response {
    const headers = new Headers()
    for (const [name, value] of stored.headers) headers.append(name, value)
    headers.set(REPLAYED_HEADER, 'true')
    return new Response(ResponseSnapshot.replayBody(stored), { status: stored.status, headers })
  }

  private static replayBody(stored: StoredResponse): Uint8Array | null {
    if (stored.body === null || NULL_BODY_STATUSES.has(stored.status)) return null
    return Buffer.from(stored.body, 'base64')
  }

  private static captureHeaders(headers: Headers, filter: HeaderFilter): Array<readonly [string, string]> {
    const stored: Array<readonly [string, string]> = []
    for (const [name, value] of headers) {
      if (stored.length >= MAX_STORED_HEADERS) break
      const lower = name.toLowerCase()
      if (filter.allows(lower, value)) stored.push([lower, value])
    }
    return stored
  }

  private static async captureBody(response: Response, maxBodyBytes: number): Promise<CapturedBody> {
    if (response.body === null) return NO_BODY
    if (response.bodyUsed) return OMITTED_BODY
    if (ResponseSnapshot.isEventStream(response.headers)) return OMITTED_BODY
    if (ResponseSnapshot.declaresOversize(response.headers, maxBodyBytes)) return OMITTED_BODY
    const reader = response.clone().body?.getReader()
    if (reader === undefined) return NO_BODY
    return ResponseSnapshot.readBody(reader, maxBodyBytes)
  }

  private static isEventStream(headers: Headers): boolean {
    const mediaType = (headers.get('content-type') ?? '').split(';')[0] ?? ''
    return mediaType.trim().toLowerCase() === EVENT_STREAM
  }

  private static declaresOversize(headers: Headers, maxBodyBytes: number): boolean {
    const declared = headers.get('content-length')
    if (declared === null) return false
    const length = Number(declared)
    return Number.isFinite(length) && length > maxBodyBytes
  }

  private static async readBody(reader: ChunkReader, maxBodyBytes: number): Promise<CapturedBody> {
    try {
      const bytes = await ResponseSnapshot.readLimited(reader, maxBodyBytes)
      if (bytes === null) return OMITTED_BODY
      return { body: bytes.toString('base64'), bodyOmitted: false }
    } catch {
      return OMITTED_BODY
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }

  private static async readLimited(reader: ChunkReader, maxBodyBytes: number): Promise<Buffer | null> {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, total)
      if (!(value instanceof Uint8Array)) throw new TypeError('Response body chunk is not bytes')
      total += value.byteLength
      if (total > maxBodyBytes) return null
      if (value.byteLength > 0) chunks.push(value)
    }
  }
}
