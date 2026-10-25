interface ChunkReader {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>
}

export class RequestFingerprint {
  static async compute(request: Request, signal?: AbortSignal): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256')
    const url = new URL(request.url)
    hasher.update(`${request.method}\n${url.pathname}${url.search}\n`)
    await RequestFingerprint.hashBody(request.clone().body, hasher, signal)
    signal?.throwIfAborted()
    return hasher.digest('hex')
  }

  private static async hashBody(body: ReadableStream<unknown> | null, hasher: Bun.CryptoHasher, signal?: AbortSignal): Promise<void> {
    if (body === null) return
    const reader = body.getReader()
    const stop = () => {
      reader.cancel().catch(() => undefined)
    }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      await RequestFingerprint.readAll(reader, hasher)
    } finally {
      signal?.removeEventListener('abort', stop)
      stop()
    }
  }

  private static async readAll(reader: ChunkReader, hasher: Bun.CryptoHasher): Promise<void> {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (!(value instanceof Uint8Array)) throw new TypeError('Request body chunk is not bytes')
      hasher.update(value)
    }
  }
}
