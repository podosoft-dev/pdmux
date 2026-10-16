import { SQL } from "bun";

// Bun 1.4 treats `close({ timeout: 0 })` like no timeout and waits for every
// pending query, so a stalled pool is closed after the shortest delay instead.
const CLOSE_NOW_SECONDS = 0.001;

// Pool members whose result is pending database work: `unsafe` and `file` build
// queries, and `begin` and `transaction` settle when the transaction ends.
const WATCHED_MEMBERS = new Set<PropertyKey>(["unsafe", "file", "begin", "transaction"]);

/** Whether PostgreSQL at `url` answers `SELECT 1` on a new connection within `timeoutMs`. */
export async function answersOnNewConnection(url: string, timeoutMs: number): Promise<boolean> {
  const sql = new SQL(url, { max: 1, connectionTimeout: timeoutMs / 1000 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([sql`SELECT 1`.then(() => true, () => false), deadline]);
  } finally {
    clearTimeout(timer);
    void sql.close({ timeout: CLOSE_NOW_SECONDS }).catch(() => undefined);
  }
}

export interface PoolGuardOptions {
  /** How long a query or transaction may stay pending before the server is checked. */
  stallTimeoutMs: number;
  /** Resolves whether the server answers a new connection now; never rejects. */
  serverAnswers: () => Promise<boolean>;
}

interface Generation {
  sql: SQL;
  /** Whether a query on this pool has succeeded, so it may hold connections the server stopped answering. */
  answered: boolean;
}

/**
 * Keeps a Bun SQL pool usable when PostgreSQL keeps its connections open but
 * stops answering, as a paused container, a frozen VM, or a network partition
 * does. Bun SQL has no query timeout, `query.cancel()` does not stop a query
 * that is running, and one pool connection cannot be closed on its own, so a
 * query on such a connection waits until the server answers again or TCP gives
 * up, and the pool keeps the connection.
 *
 * `sql` stands in for the pool and passes every call through. A query or
 * transaction still pending after `stallTimeoutMs` makes the guard check the
 * server on a new connection. When the server does not answer either, the guard
 * opens a new pool and closes the old one, which fails every query still waiting
 * on it with `ERR_POSTGRES_CONNECTION_CLOSED`. A slow query on a server that
 * answers keeps running.
 */
export class PoolGuard {
  readonly sql: SQL;
  private generation: Generation;
  private checking?: Promise<void>;
  private readonly lostListeners: Array<(reason: Error) => void> = [];

  constructor(
    private readonly open: () => SQL,
    private readonly options: PoolGuardOptions,
  ) {
    this.generation = { sql: open(), answered: false };
    this.sql = new Proxy(this.generation.sql, {
      apply: (_target, _thisArg, args: unknown[]) => {
        const generation = this.generation;
        return this.watch(generation, Reflect.apply(generation.sql, undefined, args));
      },
      get: (_target, key) => this.member(key),
      has: (_target, key) => Reflect.has(this.generation.sql, key),
    });
  }

  /** Takes the callback to run whenever the guard replaces a pool the server stopped answering. */
  onLost(listener: (reason: Error) => void): void {
    this.lostListeners.push(listener);
  }

  private member(key: PropertyKey): unknown {
    const generation = this.generation;
    const value: unknown = Reflect.get(generation.sql, key);
    if (typeof value !== "function") return value;
    return (...args: unknown[]): unknown => {
      const result: unknown = Reflect.apply(value, generation.sql, args);
      return WATCHED_MEMBERS.has(key) ? this.watch(generation, result) : result;
    };
  }

  private watch(generation: Generation, result: unknown): unknown {
    if (!(result instanceof Promise)) return result;
    const pending: Promise<unknown> = result;
    const then = pending.then;
    // A transaction is a plain promise that is already running, and `await`
    // does not call `then` on a plain promise.
    if (Object.getPrototypeOf(pending) === Promise.prototype) {
      this.track(generation, pending, then);
      return pending;
    }
    // Bun builds a query without running it, and the same object can be nested
    // in another query as a fragment, so the clock starts with the first `then`,
    // which is what runs it. Every call still reaches Bun's own `then`.
    let tracked = false;
    Object.defineProperty(pending, "then", {
      configurable: true,
      writable: true,
      value: (...args: Parameters<Promise<unknown>["then"]>): Promise<unknown> => {
        const chained = then.apply(pending, args);
        if (!tracked) {
          tracked = true;
          this.track(generation, pending, then);
        }
        return chained;
      },
    });
    return pending;
  }

  private track(generation: Generation, pending: Promise<unknown>, then: Promise<unknown>["then"]): void {
    const timer = setTimeout(() => this.stalled(generation), this.options.stallTimeoutMs);
    timer.unref?.();
    then.call(
      pending,
      () => {
        clearTimeout(timer);
        generation.answered = true;
      },
      () => clearTimeout(timer),
    );
  }

  private stalled(generation: Generation): void {
    // A pool that never answered holds only connections that are still opening,
    // and the connection timeout ends those.
    if (generation !== this.generation || !generation.answered) return;
    this.checking ??= this.check(generation).finally(() => {
      this.checking = undefined;
    });
  }

  private async check(generation: Generation): Promise<void> {
    if (await this.options.serverAnswers()) return;
    if (generation !== this.generation) return;
    this.generation = { sql: this.open(), answered: false };
    void generation.sql.close({ timeout: CLOSE_NOW_SECONDS }).catch(() => undefined);
    const reason = new Error(
      `PostgreSQL left a query unanswered for ${this.options.stallTimeoutMs} ms and did not answer a new connection; replaced the pool`,
    );
    for (const listener of this.lostListeners) listener(reason);
  }
}
