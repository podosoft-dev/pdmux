export type ReadinessStatus = "up" | "down";
export type ReadinessCheck = () => Promise<void>;
export type ReadinessResults = Record<string, ReadinessStatus>;

export const DEFAULT_READINESS_CHECK_TIMEOUT_MS = 800;
export const DEFAULT_READINESS_CACHE_MS = 2_000;

/** The core database check. The health endpoint reports it as `db`, apart from module checks. */
export const DATABASE_READINESS_CHECK = "database";

export interface ReadinessOptions {
  /** Longest one check may run before it is reported down. */
  timeoutMs?: number;
  /** How long a finished evaluation is reused. `0` evaluates on every run. */
  cacheMs?: number;
  /** Receives the reason for each check that is down, once per evaluation. */
  onCheckFailure?: (name: string, reason: string) => void;
}

class ReadinessTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Readiness check "${name}" timed out after ${timeoutMs} ms`);
    this.name = "ReadinessTimeoutError";
  }
}

export class ReadinessService {
  private readonly checks = new Map<string, ReadinessCheck>();
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly onCheckFailure: ((name: string, reason: string) => void) | undefined;
  // Bumped whenever the registered checks change, so an evaluation that started
  // earlier is neither shared nor cached afterwards.
  private generation = 0;
  private inFlight?: Promise<ReadinessResults>;
  private cached?: { results: ReadinessResults; expiresAt: number };

  constructor(options: ReadinessOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_CHECK_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? DEFAULT_READINESS_CACHE_MS;
    this.onCheckFailure = options.onCheckFailure;
  }

  register(name: string, check: ReadinessCheck): () => void {
    if (this.checks.has(name)) {
      throw new Error(`Readiness check "${name}" is already registered`);
    }
    this.checks.set(name, check);
    this.invalidate();
    return () => {
      this.checks.delete(name);
      this.invalidate();
    };
  }

  /**
   * Runs every check in parallel, each bounded by the timeout. Concurrent callers
   * share one evaluation, and a finished one is reused for the cache window.
   */
  async run(): Promise<ReadinessResults> {
    if (this.cached && Date.now() < this.cached.expiresAt) return { ...this.cached.results };
    this.inFlight ??= this.evaluate(this.generation);
    return { ...(await this.inFlight) };
  }

  private invalidate(): void {
    this.generation += 1;
    this.inFlight = undefined;
    this.cached = undefined;
  }

  private async evaluate(generation: number): Promise<ReadinessResults> {
    try {
      const entries = await Promise.all(
        [...this.checks].map(
          async ([name, check]): Promise<[string, ReadinessStatus]> => [name, await this.probe(name, check)],
        ),
      );
      const results: ReadinessResults = Object.fromEntries(entries);
      if (generation === this.generation && this.cacheMs > 0) {
        this.cached = { results, expiresAt: Date.now() + this.cacheMs };
      }
      return results;
    } finally {
      if (generation === this.generation) this.inFlight = undefined;
    }
  }

  private async probe(name: string, check: ReadinessCheck): Promise<ReadinessStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadinessTimeoutError(name, this.timeoutMs)), this.timeoutMs);
    });
    try {
      await Promise.race([check(), timeout]);
      return "up";
    } catch (error) {
      this.onCheckFailure?.(name, error instanceof Error ? error.message : String(error));
      return "down";
    } finally {
      clearTimeout(timer);
    }
  }
}
