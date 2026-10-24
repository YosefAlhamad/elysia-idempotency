export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>()

  get pendingKeys(): number {
    return this.tails.size
  }

  run<TResult>(key: string, task: () => Promise<TResult>): Promise<TResult> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail: Promise<void> = result.then(
      (): void => this.release(key, tail),
      (): void => this.release(key, tail),
    )
    this.tails.set(key, tail)
    return result
  }

  private release(key: string, tail: Promise<void>): void {
    if (this.tails.get(key) === tail) this.tails.delete(key)
  }
}
