/**
 * First-come mutual exclusion per key. Work under a key waits only for earlier work under the
 * same key, and a key's entry is dropped as soon as nothing holds or awaits it.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Keys currently held or awaited. */
  get size(): number { return this.tails.size; }

  /**
   * Takes every key and resolves with an idempotent release. Keys are taken in sorted order, so
   * two callers that share keys cannot each hold one the other is waiting for.
   */
  async acquire(keys: readonly string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const key of [...new Set(keys)].sort()) releases.push(await this.take(key));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  async run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(keys);
    try { return await work(); } finally { release(); }
  }

  private async take(key: string): Promise<() => void> {
    const prior = this.tails.get(key);
    let open!: () => void;
    const tail = new Promise<void>(resolve => { open = resolve; });
    this.tails.set(key, tail);
    if (prior) await prior;
    return () => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
      open();
    };
  }
}
