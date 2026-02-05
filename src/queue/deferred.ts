export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
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
