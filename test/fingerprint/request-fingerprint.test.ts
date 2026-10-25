import { describe, expect, test } from 'bun:test'
import { RequestFingerprint } from '../../src/fingerprint/request-fingerprint'

const SHA256_HEX = /^[0-9a-f]{64}$/
const MEGABYTE = 1024 * 1024
const CHUNK_BYTES = 64 * 1024

const fingerprint = (url: string, init: RequestInit = {}): Promise<string> =>
  RequestFingerprint.compute(new Request(url, init))

const post = (url: string, body: string): Promise<string> => fingerprint(url, { method: 'POST', body })

const sha256 = (...parts: ReadonlyArray<string | Uint8Array>): string => {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const part of parts) hasher.update(part)
  return hasher.digest('hex')
}

const generatedBody = (totalBytes: number): ReadableStream<Uint8Array> => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close()
      controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(sent % 251))
      sent += CHUNK_BYTES
    },
  })
}

const drain = async (stream: ReadableStream<Uint8Array> | null): Promise<number> => {
  if (stream === null) return 0
  const reader = stream.getReader()
  let total = 0
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) total += chunk.value.byteLength
  return total
}

describe('RequestFingerprint.compute', () => {
  test('hashes method, newline, path and query, newline, then the body', async () => {
    const actual = await post('http://localhost/orders?x=1', '{"a":1}')
    expect(actual).toBe(sha256('POST\n/orders?x=1\n', '{"a":1}'))
    expect(actual).toMatch(SHA256_HEX)
  })

  test('hashes only method and path for a request with no body', async () => {
    expect(await fingerprint('http://localhost/orders', { method: 'POST' })).toBe(sha256('POST\n/orders\n'))
  })

  test('an empty body hashes the same as no body', async () => {
    expect(await post('http://localhost/orders', '')).toBe(sha256('POST\n/orders\n'))
  })

  test('identical requests give identical fingerprints', async () => {
    const first = await post('http://localhost/orders?x=1', '{"amount":100}')
    expect(await post('http://localhost/orders?x=1', '{"amount":100}')).toBe(first)
  })

  test('ignores host, scheme, fragment, and headers', async () => {
    const first = await post('http://localhost/orders', 'body')
    const second = await fingerprint('https://example.com/orders#top', {
      method: 'POST',
      body: 'body',
      headers: { 'x-other': '1' },
    })
    expect(second).toBe(first)
  })

  test('differs by method', async () => {
    const body = 'same'
    const posted = await fingerprint('http://localhost/orders', { method: 'POST', body })
    expect(await fingerprint('http://localhost/orders', { method: 'PUT', body })).not.toBe(posted)
    expect(await fingerprint('http://localhost/orders', { method: 'PATCH', body })).not.toBe(posted)
  })

  test('differs by path', async () => {
    expect(await post('http://localhost/orders', 'x')).not.toBe(await post('http://localhost/payments', 'x'))
  })

  test('differs by query', async () => {
    const first = await post('http://localhost/orders?x=1', 'x')
    expect(await post('http://localhost/orders?x=2', 'x')).not.toBe(first)
    expect(await post('http://localhost/orders', 'x')).not.toBe(first)
  })

  test('differs by body', async () => {
    expect(await post('http://localhost/orders', '{"amount":100}')).not.toBe(
      await post('http://localhost/orders', '{"amount":101}'),
    )
  })

  test('the newline separators stop path and body from running together', async () => {
    expect(await post('http://localhost/ab', 'c')).not.toBe(await post('http://localhost/a', 'bc'))
  })

  test('hashes binary bodies byte for byte', async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128])
    expect(await fingerprint('http://localhost/upload', { method: 'POST', body: bytes })).toBe(
      sha256('POST\n/upload\n', bytes),
    )
  })

  test('leaves the original body readable', async () => {
    const request = new Request('http://localhost/orders', { method: 'POST', body: '{"a":1}' })
    await RequestFingerprint.compute(request)
    expect(await request.text()).toBe('{"a":1}')
  })

  test.each(['text', { a: 1 }, 42])('rejects a body chunk %p that is not bytes and cancels the clone', async (chunk) => {
    let cancelled = false
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request('http://localhost/upload', { method: 'POST', body: body as ReadableStream<Uint8Array> })
    const result = RequestFingerprint.compute(request)
    await request.body?.cancel()
    await expect(result).rejects.toThrow('Request body chunk is not bytes')
    expect(cancelled).toBe(true)
  })

  test('stops reading and rejects when aborted mid-body', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(8)),
      pull: () => {
        pulls += 1
      },
    })
    const request = new Request('http://localhost/upload', { method: 'POST', body })
    const stop = new AbortController()
    const result = RequestFingerprint.compute(request, stop.signal)
    stop.abort()
    await expect(result).rejects.toThrow()
    const pullsAtAbort = pulls
    await request.body?.cancel()
    expect(pulls).toBe(pullsAtAbort)
  })

  test('rejects at once when already aborted', async () => {
    const request = new Request('http://localhost/orders', { method: 'POST', body: '{"a":1}' })
    await expect(RequestFingerprint.compute(request, AbortSignal.abort())).rejects.toThrow()
    expect(await request.text()).toBe('{"a":1}')
  })

  test('streams a 50 MB body without holding it in memory', async () => {
    const totalBytes = 50 * MEGABYTE
    const request = new Request('http://localhost/upload', { method: 'POST', body: generatedBody(totalBytes) })
    Bun.gc(true)
    const before = process.memoryUsage().rss
    const [actual, drained] = await Promise.all([RequestFingerprint.compute(request), drain(request.body)])
    const growth = process.memoryUsage().rss - before
    expect(drained).toBe(totalBytes)
    expect(actual).toMatch(SHA256_HEX)
    expect(growth).toBeLessThan(25 * MEGABYTE)
  })
})
