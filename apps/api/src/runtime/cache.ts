export interface CacheIncrement {
  count: number;
  retryAfterSeconds: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<number>;
  incrementFixedWindow(key: string, ttlSeconds: number): Promise<CacheIncrement>;
  close(): void | Promise<void>;
}

interface MemoryEntry {
  value: string;
  expiresAt?: number;
  touchedAt: number;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly maximumEntries = 10_000) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("Memory cache maximumEntries must be a positive integer");
    }
  }

  get(key: string): Promise<string | null> {
    const entry = this.liveEntry(key);
    if (!entry) return Promise.resolve(null);
    entry.touchedAt = Date.now();
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      ...(ttlSeconds === undefined ? {} : { expiresAt: Date.now() + ttlSeconds * 1_000 }),
      touchedAt: Date.now(),
    });
    this.evict();
    return Promise.resolve();
  }

  delete(key: string): Promise<number> {
    return Promise.resolve(this.entries.delete(key) ? 1 : 0);
  }

  incrementFixedWindow(key: string, ttlSeconds: number): Promise<CacheIncrement> {
    const now = Date.now();
    const existing = this.liveEntry(key);
    const count = existing ? Number(existing.value) + 1 : 1;
    const expiresAt = existing?.expiresAt ?? now + ttlSeconds * 1_000;
    this.entries.set(key, { value: String(count), expiresAt, touchedAt: now });
    this.evict();
    return Promise.resolve({
      count,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000)),
    });
  }

  close(): void {
    this.entries.clear();
  }

  private liveEntry(key: string): MemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private evict(): void {
    if (this.entries.size <= this.maximumEntries) return;
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        this.entries.delete(key);
      } else if (entry.touchedAt < oldestTime) {
        oldestKey = key;
        oldestTime = entry.touchedAt;
      }
    }
    if (this.entries.size > this.maximumEntries && oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
