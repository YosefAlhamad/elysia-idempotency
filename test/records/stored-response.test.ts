import { describe, expect, spyOn, test } from 'bun:test'
import { HeaderFilter, MAX_HEADER_VALUE_LENGTH } from '../../src/records/header-filter'
import { type CompletedRecord, IdempotencyRecordCodec } from '../../src/records/idempotency-record'
import { ResponseSnapshot, type StoredResponse, storedResponseSchema } from '../../src/records/stored-response'

const options = { maxBodyBytes: 4096, headerFilter: new HeaderFilter() }

const countingStream = (chunkCount: number, chunkSize: number) => {
  const counter = { pulls: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      counter.pulls += 1
      if (counter.pulls > chunkCount) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(chunkSize).fill(counter.pulls % 256))
    },
    cancel() {
      counter.cancelled = true
    },
  })
  return { stream, counter }
}

const decodeBody = (stored: StoredResponse) => (stored.body === null ? null : Buffer.from(stored.body, 'base64'))

describe('ResponseSnapshot.capture', () => {
  test('captures a JSON response', async () => {
    const response = Response.json({ id: 1, amount: 500 }, { status: 201 })
    const stored = await ResponseSnapshot.capture(response, options)
    expect(stored.status).toBe(201)
    expect(stored.bodyOmitted).toBe(false)
    expect(JSON.parse(decodeBody(stored)?.toString() ?? '')).toEqual({ id: 1, amount: 500 })
    expect(stored.headers).toContainEqual(['content-type', 'application/json;charset=utf-8'])
  })

  test('captures a text response', async () => {
    const stored = await ResponseSnapshot.capture(new Response('héllo wörld'), options)
    expect(decodeBody(stored)?.toString('utf8')).toBe('héllo wörld')
  })

  test('captures a binary response byte for byte', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const stored = await ResponseSnapshot.capture(new Response(bytes), options)
    expect(new Uint8Array(decodeBody(stored) ?? [])).toEqual(bytes)
  })

  test('captures a response with no body', async () => {
    const stored = await ResponseSnapshot.capture(new Response(null, { status: 204 }), options)
    expect(stored).toEqual({ status: 204, headers: [], body: null, bodyOmitted: false })
  })

  test('captures an empty body as an empty string', async () => {
    const stored = await ResponseSnapshot.capture(new Response(''), options)
    expect(stored).toMatchObject({ body: '', bodyOmitted: false })
  })

  test('captures a body of exactly maxBodyBytes', async () => {
    const stored = await ResponseSnapshot.capture(new Response(new Uint8Array(4096)), options)
    expect(stored.bodyOmitted).toBe(false)
    expect(decodeBody(stored)?.byteLength).toBe(4096)
  })

  test('stops reading an oversized body early without cancelling the source', async () => {
    const { stream, counter } = countingStream(1000, 1024)
    const response = new Response(stream)
    const stored = await ResponseSnapshot.capture(response, options)
    expect(stored.body).toBeNull()
    expect(stored.bodyOmitted).toBe(true)
    expect(counter.pulls).toBeLessThan(10)
    expect(counter.cancelled).toBe(false)
  })

  test('leaves the original readable after stopping early', async () => {
    const { stream } = countingStream(1000, 1024)
    const response = new Response(stream)
    await ResponseSnapshot.capture(response, options)
    expect((await response.arrayBuffer()).byteLength).toBe(1000 * 1024)
  })

  test('omits a body when maxBodyBytes is zero', async () => {
    const stored = await ResponseSnapshot.capture(new Response('x'), { ...options, maxBodyBytes: 0 })
    expect(stored).toMatchObject({ body: null, bodyOmitted: true })
  })

  test('never reads a body whose content-length is over the limit', async () => {
    const { stream, counter } = countingStream(1000, 1024)
    const response = new Response(stream, { headers: { 'content-length': String(1000 * 1024) } })
    const clone = spyOn(response, 'clone')
    const stored = await ResponseSnapshot.capture(response, options)
    expect(stored).toMatchObject({ body: null, bodyOmitted: true })
    expect(clone).not.toHaveBeenCalled()
    expect(counter.pulls).toBeLessThanOrEqual(1)
  })

  test.each(['text/event-stream', 'Text/Event-Stream; charset=utf-8'])('never reads a %p body', async (contentType) => {
    const { stream, counter } = countingStream(1000, 1024)
    const response = new Response(stream, { headers: { 'content-type': contentType } })
    const clone = spyOn(response, 'clone')
    const stored = await ResponseSnapshot.capture(response, options)
    expect(stored).toMatchObject({ body: null, bodyOmitted: true })
    expect(clone).not.toHaveBeenCalled()
    expect(counter.pulls).toBeLessThanOrEqual(1)
    expect(response.bodyUsed).toBe(false)
  })

  test('reads from a clone and leaves the original unread', async () => {
    const response = new Response('payload')
    const clone = spyOn(response, 'clone')
    await ResponseSnapshot.capture(response, options)
    expect(clone).toHaveBeenCalledTimes(1)
    expect(response.bodyUsed).toBe(false)
    expect(await response.text()).toBe('payload')
  })

  test('omits a body that was already consumed', async () => {
    const response = new Response('payload')
    await response.text()
    expect(await ResponseSnapshot.capture(response, options)).toMatchObject({ body: null, bodyOmitted: true })
  })

  test('omits a body whose stream fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('broken'))
      },
    })
    const stored = await ResponseSnapshot.capture(new Response(stream), options)
    expect(stored).toMatchObject({ body: null, bodyOmitted: true })
  })

  const streamOf = (chunks: readonly unknown[]) =>
    new Response(
      new ReadableStream<unknown>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }) as ReadableStream<Uint8Array>,
    )

  test('captures string chunks as UTF-8, as Elysia streams them', async () => {
    const stored = await ResponseSnapshot.capture(streamOf(['héllo ', 'wörld']), options)
    expect(Buffer.from(stored.body ?? '', 'base64').toString('utf8')).toBe('héllo wörld')
    expect(stored.bodyOmitted).toBe(false)
  })

  test('counts string chunks in bytes against maxBodyBytes', async () => {
    const stored = await ResponseSnapshot.capture(streamOf(['é'.repeat(3)]), { ...options, maxBodyBytes: 5 })
    expect(stored).toMatchObject({ body: null, bodyOmitted: true })
  })

  test('omits a body with non-byte chunks and leaves the original readable', async () => {
    const response = streamOf([42])
    const stored = await ResponseSnapshot.capture(response, options)
    expect(stored).toMatchObject({ body: null, bodyOmitted: true })
    expect(response.body).not.toBeNull()
  })

  test('captures header values with any byte that Headers accepts', async () => {
    const value = 'a\u0001\u0008\u000b\u001f\u007fé'
    const response = new Response('ok', { headers: { 'x-odd': value } })
    const stored = await ResponseSnapshot.capture(response, options)
    expect(stored.headers).toContainEqual(['x-odd', value])
    expect(storedResponseSchema.safeParse(stored).success).toBe(true)
  })

  test('drops a header value over the length limit', async () => {
    const headers = { 'x-huge': 'v'.repeat(MAX_HEADER_VALUE_LENGTH + 1), 'x-small': 'v' }
    const stored = await ResponseSnapshot.capture(new Response('ok', { headers }), options)
    expect(stored.headers).toEqual([['x-small', 'v']])
  })

  test.each([
    ['odd header bytes', () => new Response('ok', { headers: { 'x-odd': '\u0001\u007fÿ', 'X-Upper': 'v' } })],
    ['a huge header', () => new Response('ok', { headers: { 'x-huge': 'v'.repeat(100_000) } })],
    ['150 headers', () => new Response('ok', { headers: Array.from({ length: 150 }, (_, i): [string, string] => [`x-h${i}`, 'v']) })],
    ['an oversized body', () => new Response(new Uint8Array(5000))],
    ['an empty 204', () => new Response(null, { status: 204 })],
    ['an event stream', () => new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream' } })],
  ])('captures %s as a record that decodes again', async (_, makeResponse) => {
    const codec = new IdempotencyRecordCodec()
    const response = await ResponseSnapshot.capture(makeResponse(), options)
    const record: CompletedRecord = { state: 'completed', fingerprint: null, completedAt: 0, response }
    expect(codec.decode(codec.encode(record))).toEqual(record)
  })

  test('never stores set-cookie, auth, hop-by-hop, or rate limit headers', async () => {
    const headers = new Headers([
      ['content-type', 'text/plain'],
      ['x-trace', 'abc'],
      ['set-cookie', 'session=secret'],
      ['set-cookie', 'other=secret'],
      ['authorization', 'Bearer secret'],
      ['proxy-authenticate', 'Basic'],
      ['connection', 'close'],
      ['keep-alive', 'timeout=5'],
      ['upgrade', 'websocket'],
      ['date', 'Thu, 01 Jan 2026 00:00:00 GMT'],
      ['retry-after', '1'],
      ['idempotent-replayed', 'true'],
      ['ratelimit-remaining', '3'],
      ['ratelimit-policy', '10;w=60'],
    ])
    const stored = await ResponseSnapshot.capture(new Response('ok', { headers }), options)
    expect(stored.headers.map(([name]) => name).sort()).toEqual(['content-type', 'x-trace'])
  })

  test('applies user exclusions', async () => {
    const response = new Response('ok', { headers: { 'X-Request-Id': '1', 'X-Keep': '2' } })
    const stored = await ResponseSnapshot.capture(response, { ...options, headerFilter: new HeaderFilter(['x-request-id']) })
    expect(stored.headers).toEqual([['x-keep', '2']])
  })

  test('stores at most 100 headers with lowercase names', async () => {
    const headers = new Headers(Array.from({ length: 150 }, (_, i): [string, string] => [`X-Header-${i}`, 'v']))
    const stored = await ResponseSnapshot.capture(new Response(null, { headers }), options)
    expect(stored.headers.length).toBe(100)
    expect(stored.headers.every(([name]) => name === name.toLowerCase())).toBe(true)
  })

  test('produces a value that passes the stored response schema', async () => {
    const response = new Response(Uint8Array.from([0, 1, 2, 255]), { status: 202, headers: { etag: '"v1"' } })
    const stored = await ResponseSnapshot.capture(response, options)
    expect(storedResponseSchema.safeParse(stored).success).toBe(true)
  })
})

describe('ResponseSnapshot.toResponse', () => {
  const stored: StoredResponse = {
    status: 201,
    headers: [
      ['content-type', 'application/json'],
      ['location', '/payments/1'],
      ['vary', 'a'],
      ['vary', 'b'],
    ],
    body: Buffer.from('{"id":1}').toString('base64'),
    bodyOmitted: false,
  }

  test('rebuilds status, headers, and body', async () => {
    const response = ResponseSnapshot.toResponse(stored)
    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('location')).toBe('/payments/1')
    expect(response.headers.get('vary')).toBe('a, b')
    expect(await response.json()).toEqual({ id: 1 })
  })

  test('adds Idempotent-Replayed: true', () => {
    expect(ResponseSnapshot.toResponse(stored).headers.get('Idempotent-Replayed')).toBe('true')
  })

  test('overrides a stored Idempotent-Replayed value', () => {
    const response = ResponseSnapshot.toResponse({ ...stored, headers: [['idempotent-replayed', 'false']] })
    expect(response.headers.get('idempotent-replayed')).toBe('true')
  })

  test('replays an omitted body as empty with status and headers kept', async () => {
    const response = ResponseSnapshot.toResponse({ ...stored, body: null, bodyOmitted: true })
    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe('/payments/1')
    expect(await response.text()).toBe('')
  })

  test('replays a body-less status without a body', async () => {
    const response = ResponseSnapshot.toResponse({ ...stored, status: 204 })
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  test('round trips binary data through capture and replay', async () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 7) % 256)
    const captured = await ResponseSnapshot.capture(new Response(bytes, { status: 200 }), options)
    const replay = ResponseSnapshot.toResponse(captured)
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(bytes)
  })
})
