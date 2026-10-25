export interface Deferred<TValue> {
  readonly promise: Promise<TValue>
  readonly resolve: (value: TValue) => void
}

export const deferred = <TValue = void>(): Deferred<TValue> => {
  const { promise, resolve } = Promise.withResolvers<TValue>()
  return { promise, resolve }
}
