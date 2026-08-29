// Small in-process caches. Deliberately not Redis: this app is a single Fly
// machine per region and every entry is cheap to recompute, so the operational
// cost of another service is not worth it. Everything here is therefore
// per-process — TTLs are short enough that a second machine converging a few
// seconds later is invisible to shoppers.

interface Entry<V> {
  at: number;
  value: V;
}

/** LRU + TTL. Eviction is by insertion order, which Map preserves. */
export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number = 1000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.store.delete(key);
    this.store.set(key, { at: Date.now(), value });
    while (this.store.size > this.max) {
      this.store.delete(this.store.keys().next().value as string);
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drop every entry whose key starts with `prefix` (used to invalidate a shop). */
  deletePrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  /** Memoise an async producer under `key`. Concurrent misses share one call. */
  async wrap(key: string, produce: () => Promise<V>): Promise<V> {
    // Probe for PRESENCE, not for a non-undefined value: a legitimately cached
    // `undefined` read as a miss and was recomputed on every single call.
    const entry = this.store.get(key);
    if (entry) {
      if (Date.now() - entry.at <= this.ttlMs) {
        // Refresh recency, same as get().
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
      }
      this.store.delete(key);
    }

    const inflight = this.pending.get(key);
    if (inflight) return inflight as Promise<V>;

    const p = produce()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.pending.delete(key));

    this.pending.set(key, p);
    return p;
  }

  // Single-flight map: without it, a cold cache under load fires the same
  // expensive facet query once per concurrent request instead of once.
  private readonly pending = new Map<string, Promise<V>>();
}

/**
 * Fixed-window rate limiter. `proxy/track` accepts writes from anonymous
 * storefront visitors, so without a ceiling one script can inflate a product's
 * popularity or hammer the database.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True when the caller is still within budget. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      this.sweep(now);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  // Bounded memory: drop windows that have already expired. Cheap because it
  // only runs when a brand-new key arrives.
  private sweep(now: number) {
    if (this.hits.size < 5000) return;
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart > this.windowMs) this.hits.delete(key);
    }
  }
}
