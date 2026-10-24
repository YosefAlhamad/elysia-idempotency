import type { Clock } from '../../src/core/clock'
import type { RedisCommandClient } from '../../src/stores/redis-store'
import { ManualClock } from './manual-clock'

interface FakeEntry {
  readonly value: string
  readonly expiresAt: number
}

type CommandHandler = (args: readonly string[]) => unknown

export class FakeRedis implements RedisCommandClient {
  private readonly entries = new Map<string, FakeEntry>()
  private readonly scripts = new Set<string>()
  private readonly sent: string[] = []
  private readonly handlers: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
    ['GET', (args) => this.get(this.argument(args, 0))],
    ['SET', (args) => this.setCommand(args)],
    ['DEL', (args) => this.deleteKeys(args)],
    ['PTTL', (args) => this.pttl(this.argument(args, 0))],
    ['EVAL', (args) => this.evalCommand(args)],
    ['EVALSHA', (args) => this.evalShaCommand(args)],
    ['SCRIPT', (args) => this.scriptCommand(args)],
  ])
  private beforeScript: (() => void) | undefined
  private failure: Error | undefined

  constructor(private readonly clock: Clock = new ManualClock()) {}

  get commands(): readonly string[] {
    return this.sent
  }

  onBeforeScript(hook: (() => void) | undefined): void {
    this.beforeScript = hook
  }

  failWith(error: Error | undefined): void {
    this.failure = error
  }

  flushScripts(): void {
    this.scripts.clear()
  }

  set(key: string, value: string, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.clock.now() + ttlMs })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  get(key: string): string | null {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    if (entry.expiresAt > this.clock.now()) return entry.value
    this.entries.delete(key)
    return null
  }

  async send(command: string, args: string[]): Promise<unknown> {
    this.sent.push(command)
    if (this.failure !== undefined) throw this.failure
    const handler = this.handlers.get(command.toUpperCase())
    if (handler === undefined) throw new Error(`ERR unknown command '${command}'`)
    return handler(args)
  }

  private pttl(key: string): number {
    const entry = this.entries.get(key)
    if (this.get(key) === null || entry === undefined) return -2
    return entry.expiresAt - this.clock.now()
  }

  private setCommand(args: readonly string[]): string {
    const ttlMs = args[2]?.toUpperCase() === 'PX' ? Number(this.argument(args, 3)) : Number.POSITIVE_INFINITY
    this.set(this.argument(args, 0), this.argument(args, 1), ttlMs)
    return 'OK'
  }

  private deleteKeys(keys: readonly string[]): number {
    return keys.filter((key) => this.entries.delete(key)).length
  }

  private evalCommand(args: readonly string[]): number {
    const [script, ...rest] = args
    if (script === undefined) throw new Error('ERR wrong number of arguments')
    this.scripts.add(FakeRedis.sha(script))
    return this.compareAndWrite(rest)
  }

  private evalShaCommand(args: readonly string[]): number {
    const [sha, ...rest] = args
    if (sha === undefined || !this.scripts.has(sha)) throw new Error('NOSCRIPT No matching script. Please use EVAL.')
    return this.compareAndWrite(rest)
  }

  private scriptCommand(args: readonly string[]): string {
    if (args[0]?.toUpperCase() !== 'LOAD') throw new Error('ERR unknown SCRIPT subcommand')
    const sha = FakeRedis.sha(this.argument(args, 1))
    this.scripts.add(sha)
    return sha
  }

  private compareAndWrite(args: readonly string[]): number {
    this.beforeScript?.()
    const [, key, existed, expected, action, value, ttlMs] = args
    if (key === undefined || value === undefined || ttlMs === undefined) throw new Error('ERR wrong arguments')
    const current = this.get(key)
    if (existed === '0' ? current !== null : current !== expected) return 0
    if (action === 'delete') this.entries.delete(key)
    else this.set(key, value, Number(ttlMs))
    return 1
  }

  private argument(args: readonly string[], index: number): string {
    const value = args[index]
    if (value === undefined) throw new Error('ERR wrong number of arguments')
    return value
  }

  private static sha(script: string): string {
    return new Bun.CryptoHasher('sha1').update(script).digest('hex')
  }
}
