import { z } from 'zod'
import { IdempotencyConfigError, StoreConflictError, StoreUnavailableError } from '../errors'
import { KeyedQueue } from './keyed-queue'
import { type IdempotencyStore, type StoreMutation, type StoreWrite, normalizeTtlMs } from './store'

export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>
}

export interface RedisStoreOptions {
  readonly client: RedisCommandClient
  readonly maxAttempts?: number
}

type ScriptWrite<TResult> = Exclude<StoreWrite<TResult>, { readonly action: 'keep' }>

const isRedisCommandClient = (value: unknown): value is RedisCommandClient =>
  typeof value === 'object' && value !== null && 'send' in value && typeof value.send === 'function'

const redisStoreOptionsSchema = z.strictObject({
  client: z.custom<RedisCommandClient>(isRedisCommandClient, 'Expected a client with a send() method'),
  maxAttempts: z.number().int().min(1).max(20).default(5),
})

export class RedisStore implements IdempotencyStore {
  private static readonly COMPARE_AND_WRITE_SCRIPT = [
    "local current = redis.call('GET', KEYS[1])",
    "if ARGV[1] == '0' then",
    '  if current then return 0 end',
    'elseif current ~= ARGV[2] then',
    '  return 0',
    'end',
    "if ARGV[3] == 'delete' then",
    "  redis.call('DEL', KEYS[1])",
    'else',
    "  redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])",
    'end',
    'return 1',
  ].join('\n')

  private static readonly COMPARE_AND_WRITE_SHA = Bun.CryptoHasher.hash('sha1', RedisStore.COMPARE_AND_WRITE_SCRIPT, 'hex')

  private readonly client: RedisCommandClient
  private readonly maxAttempts: number
  private readonly queue = new KeyedQueue()

  constructor(options: RedisStoreOptions) {
    const result = redisStoreOptionsSchema.safeParse(options)
    if (!result.success) throw new IdempotencyConfigError(result.error)
    this.client = result.data.client
    this.maxAttempts = result.data.maxAttempts
  }

  async read(key: string): Promise<string | null> {
    const reply = await this.send('GET', [key])
    if (reply === null || typeof reply === 'string') return reply
    throw new StoreUnavailableError('Idempotency store returned an unexpected reply')
  }

  update<TResult>(key: string, mutation: StoreMutation<TResult>): Promise<TResult> {
    return this.queue.run(key, () => this.compareAndWriteLoop(key, mutation))
  }

  delete(key: string): Promise<void> {
    return this.queue.run(key, async () => {
      await this.send('DEL', [key])
    })
  }

  private async compareAndWriteLoop<TResult>(key: string, mutation: StoreMutation<TResult>): Promise<TResult> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const current = await this.read(key)
      const write = mutation(current)
      if (write.action === 'keep') return write.result
      if (await this.compareAndWrite(key, current, write)) return write.result
    }
    throw new StoreConflictError(`Idempotency record kept changing after ${this.maxAttempts} attempts`)
  }

  private async compareAndWrite<TResult>(key: string, current: string | null, write: ScriptWrite<TResult>): Promise<boolean> {
    const existed = current === null ? '0' : '1'
    const args = ['1', key, existed, current ?? '', ...RedisStore.writeArguments(write)]
    return RedisStore.isWritten(await this.runScript(args))
  }

  private async runScript(args: string[]): Promise<unknown> {
    try {
      return await this.client.send('EVALSHA', [RedisStore.COMPARE_AND_WRITE_SHA, ...args])
    } catch (error) {
      if (!RedisStore.isMissingScript(error)) throw RedisStore.unavailable(error)
      return this.send('EVAL', [RedisStore.COMPARE_AND_WRITE_SCRIPT, ...args])
    }
  }

  private async send(command: string, args: string[]): Promise<unknown> {
    try {
      return await this.client.send(command, args)
    } catch (error) {
      throw RedisStore.unavailable(error)
    }
  }

  private static writeArguments<TResult>(write: ScriptWrite<TResult>): string[] {
    if (write.action === 'delete') return ['delete', '', '0']
    return ['set', write.value, String(normalizeTtlMs(write.ttlMs))]
  }

  private static isWritten(reply: unknown): boolean {
    const code = typeof reply === 'number' || typeof reply === 'string' || typeof reply === 'bigint' ? Number(reply) : Number.NaN
    if (code === 1) return true
    if (code === 0) return false
    throw new StoreUnavailableError('Idempotency store returned an unexpected reply')
  }

  private static isMissingScript(error: unknown): boolean {
    return error instanceof Error && error.message.includes('NOSCRIPT')
  }

  private static unavailable(error: unknown): StoreUnavailableError {
    return new StoreUnavailableError('Idempotency store is unavailable', { cause: error })
  }
}
