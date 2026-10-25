export class KeyBuilder {
  constructor(private readonly prefix: string) {}

  build(scope: string, key: string): string {
    const digest = Bun.CryptoHasher.hash('sha256', JSON.stringify([scope, key]), 'hex')
    return `${this.prefix}:${digest}`
  }
}
