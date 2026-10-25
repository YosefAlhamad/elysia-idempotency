import { MemoryStore } from '../../src/stores/memory-store'
import type { IdempotencyStore, StoreMutation } from '../../src/stores/store'
import { type Deferred, deferred } from './deferred'
import { ManualClock } from './manual-clock'

export type WriteAction = 'set' | 'delete' | 'keep'

export class ObservedStore implements IdempotencyStore {
  private readonly actions: WriteAction[] = []
  private readonly waiters = new Map<WriteAction, Deferred<void>>()
  private callCount = 0

  constructor(readonly inner: MemoryStore = new MemoryStore({ clock: new ManualClock() })) {}

  get writes(): readonly WriteAction[] {
    return this.actions
  }

  get calls(): number {
    return this.callCount
  }

  next(action: WriteAction): Promise<void> {
    const waiter = deferred()
    this.waiters.set(action, waiter)
    return waiter.promise
  }

  read(key: string): Promise<string | null> {
    this.callCount += 1
    return this.inner.read(key)
  }

  update<TResult>(key: string, mutation: StoreMutation<TResult>): Promise<TResult> {
    this.callCount += 1
    return this.inner.update(key, (current) => {
      const write = mutation(current)
      this.record(write.action)
      return write
    })
  }

  delete(key: string): Promise<void> {
    this.callCount += 1
    return this.inner.delete(key)
  }

  private record(action: WriteAction): void {
    this.actions.push(action)
    this.waiters.get(action)?.resolve()
    this.waiters.delete(action)
  }
}
