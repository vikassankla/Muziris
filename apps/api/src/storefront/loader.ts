/**
 * A per-request batch loader (ADR 0014). Keys asked for in the same tick are read together by
 * one call to `batch`, and each key is read at most once per request. It lives only as long as
 * the request's context, so nothing is cached between buyers.
 */
export interface Loader<K, V> {
  load(key: K): Promise<V>;
  /** Records a value already read, so a later load of the key costs nothing. */
  prime(key: K, value: V): void;
}

/**
 * `batch` gets distinct keys and returns a map from each key's id to its value; a key missing
 * from the map gets `missing`. `idOf` turns a key into a string, so object keys can be batched.
 */
export function createLoader<K, V>(
  batch: (keys: readonly K[]) => Promise<ReadonlyMap<string, V>>,
  idOf: (key: K) => string,
  missing: V,
): Loader<K, V> {
  const settled = new Map<string, Promise<V>>();
  let queue: { key: K; id: string; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];

  const flush = async () => {
    const pending = queue;
    queue = [];
    try {
      const values = await batch(pending.map((p) => p.key));
      for (const p of pending) p.resolve(values.get(p.id) ?? missing);
    } catch (error) {
      for (const p of pending) p.reject(error);
    }
  };

  return {
    load(key) {
      const id = idOf(key);
      const known = settled.get(id);
      if (known) return known;
      const promise = new Promise<V>((resolve, reject) => {
        // After every pending microtask, so list items that resolve one after another in the
        // same tick still land in one batch.
        if (queue.length === 0) setImmediate(() => void flush());
        queue.push({ key, id, resolve, reject });
      });
      settled.set(id, promise);
      return promise;
    },
    prime(key, value) {
      const id = idOf(key);
      if (!settled.has(id)) settled.set(id, Promise.resolve(value));
    },
  };
}
