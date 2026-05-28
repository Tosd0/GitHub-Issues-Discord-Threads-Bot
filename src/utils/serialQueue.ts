export function createSerialQueue<Key>() {
  const queues = new Map<Key, Promise<void>>();

  return function enqueue(key: Key, action: () => Promise<void> | void) {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => action());
    const cleanup = () => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    };

    queues.set(key, next);
    next.then(cleanup, cleanup);
    return next;
  };
}
