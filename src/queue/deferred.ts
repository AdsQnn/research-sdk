export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export const createDeferred = <T>() => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  promise.catch(() => {});
  return {
    promise,
    resolve: (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    },
    reject: (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    },
  } as Deferred<T>;
};
