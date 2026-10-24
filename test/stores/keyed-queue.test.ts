import { describe, expect, test } from 'bun:test'
import { KeyedQueue } from '../../src/stores/keyed-queue'

const deferred = () => {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

describe('KeyedQueue', () => {
  test('runs tasks for one key one after another, in order', async () => {
    const queue = new KeyedQueue()
    const events: string[] = []
    const gate = deferred()
    const first = queue.run('a', async () => {
      events.push('first start')
      await gate.promise
      events.push('first end')
      return 1
    })
    const second = queue.run('a', async () => {
      events.push('second')
      return 2
    })
    await Promise.resolve()
    expect(events).toEqual(['first start'])
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(events).toEqual(['first start', 'first end', 'second'])
  })

  test('runs tasks for different keys at the same time', async () => {
    const queue = new KeyedQueue()
    const gate = deferred()
    const blocked = queue.run('a', () => gate.promise)
    expect(await queue.run('b', async () => 'b done')).toBe('b done')
    gate.resolve()
    await blocked
  })

  test('keeps going after a task rejects', async () => {
    const queue = new KeyedQueue()
    const failing = queue.run('a', async () => {
      throw new Error('boom')
    })
    const next = queue.run('a', async () => 'next')
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('next')
  })

  test('forgets a key once its queue is empty', async () => {
    const queue = new KeyedQueue()
    const tasks = Array.from({ length: 50 }, (_, index) => queue.run(`key-${index % 5}`, async () => index))
    expect(queue.pendingKeys).toBe(5)
    await Promise.all(tasks)
    await Promise.resolve()
    expect(queue.pendingKeys).toBe(0)
  })
})
