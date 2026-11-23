// Cross-request cache with a Redis-shaped interface. Today it is in-process
// memory; when REDIS_URL is configured a Redis implementation drops in behind
// getSharedCache() without touching callers. String values only (JSON-encode),
// exactly like Redis, so the swap cannot change behaviour.

export interface SharedCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemorySharedCache implements SharedCache {
  private store = new Map<string, { value: string; expires: number }>();

  constructor(private readonly max = 5000) {}

  async get(key: string) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlMs: number) {
    this.store.delete(key);
    if (ttlMs <= 0) return;
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    while (this.store.size > this.max) this.store.delete(this.store.keys().next().value as string);
  }

  async del(key: string) {
    this.store.delete(key);
  }
}

let instance: SharedCache | null = null;

export function getSharedCache(): SharedCache {
  // REDIS_URL support is added when Redis is provisioned (see the feature-port spec).
  if (!instance) instance = new MemorySharedCache();
  return instance;
}

/** JSON helper: memoise an async producer for ttlMs. */
export async function cachedJson<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const cache = getSharedCache();
  const hit = await cache.get(key);
  if (hit != null) return JSON.parse(hit) as T;
  const value = await produce();
  await cache.set(key, JSON.stringify(value), ttlMs);
  return value;
}
