export class RequestFingerprint {
  static async compute(request: Request): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256')
    const url = new URL(request.url)
    hasher.update(`${request.method}\n${url.pathname}${url.search}\n`)
    await RequestFingerprint.hashBody(request.clone().body, hasher)
    return hasher.digest('hex')
  }

  private static async hashBody(body: ReadableStream<unknown> | null, hasher: Bun.CryptoHasher): Promise<void> {
    if (body === null) return
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (!(value instanceof Uint8Array)) throw new TypeError('Request body chunk is not bytes')
        hasher.update(value)
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }
}
