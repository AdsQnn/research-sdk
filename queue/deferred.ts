export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export const createDeferred = <T>() => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  promise.catch(() => {});
  return { promise, resolve, reject } as Deferred<T>;
};
