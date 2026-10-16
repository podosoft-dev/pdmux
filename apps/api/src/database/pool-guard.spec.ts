import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { answersOnNewConnection, PoolGuard } from "./pool-guard";

const STALL_MS = 20;

/** Settles like a Bun query: a subclass of Promise whose `then` returns a plain promise. */
class FakeQuery extends Promise<unknown> {
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }
}

interface FakePool {
  sql: SQL;
  closed: () => boolean;
  /** Settles every query that waits for the server. */
  resume: () => void;
}

interface FakeServer {
  /** While true, queries wait until the pool closes or the server resumes. */
  stalled: boolean;
  pools: FakePool[];
}

function fakeServer(): FakeServer & { open: () => SQL } {
  const server: FakeServer = { stalled: false, pools: [] };
  const open = (): SQL => {
    const waiting = new Set<(error?: Error) => void>();
    let closed = false;
    const query = (): FakeQuery =>
      new FakeQuery((resolve, reject) => {
        if (closed) return reject(new Error("Connection closed"));
        if (!server.stalled) return resolve([{ ok: 1 }]);
        waiting.add((error) => (error ? reject(error) : resolve([{ ok: 1 }])));
      });
    const settleAll = (error?: Error): void => {
      for (const settle of waiting) settle(error);
      waiting.clear();
    };
    const sql = Object.assign((..._args: unknown[]): FakeQuery => query(), {
      begin: async (run: (tx: () => FakeQuery) => Promise<unknown>): Promise<unknown> => run(query),
      close: async (): Promise<void> => {
        closed = true;
        settleAll(new Error("Connection closed"));
      },
    });
    // The fake covers the members the guard and these tests use.
    const pool = sql as unknown as SQL;
    server.pools.push({ sql: pool, closed: () => closed, resume: () => settleAll() });
    return pool;
  };
  return Object.assign(server, { open });
}

function guarded(answers: boolean): {
  server: ReturnType<typeof fakeServer>;
  guard: PoolGuard;
  checks: () => number;
  losses: Error[];
} {
  const server = fakeServer();
  let checks = 0;
  const guard = new PoolGuard(server.open, {
    stallTimeoutMs: STALL_MS,
    serverAnswers: async () => {
      checks += 1;
      return answers;
    },
  });
  const losses: Error[] = [];
  guard.onLost((reason) => losses.push(reason));
  return { server, guard, checks: () => checks, losses };
}

function outcome(pending: Promise<unknown>): Promise<string> {
  return pending.then(() => "resolved", (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("PoolGuard", () => {
  it("passes queries, fragments, helpers, and transactions through to the pool", async () => {
    const guard = new PoolGuard(() => new SQL(":memory:", { adapter: "sqlite" }), {
      stallTimeoutMs: STALL_MS,
      serverAnswers: async () => true,
    });
    const { sql } = guard;
    try {
      await sql`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)`;
      await sql`INSERT INTO item ${sql([{ id: 1, name: "a" }, { id: 2, name: "b" }], "id", "name")}`;
      const filter = sql`WHERE "name" = ${"b"}`;
      expect(await sql<{ id: number }[]>`SELECT "id" FROM item ${filter}`).toEqual([{ id: 2 }]);
      expect(await sql`SELECT count(*) AS n FROM item`.values()).toEqual([[2]]);
      const names = await sql.begin(async (tx) => {
        await tx`UPDATE item SET "name" = 'c' WHERE "id" = 1`;
        return tx`SELECT "name" FROM item ORDER BY "id"`;
      });
      expect(names).toEqual([{ name: "c" }, { name: "b" }]);
      expect(await Promise.all([sql`SELECT 1 AS v`, sql.unsafe("SELECT 2 AS v")])).toEqual([[{ v: 1 }], [{ v: 2 }]]);
    } finally {
      await sql.close();
    }
  });

  it("replaces the pool when a query stalls and the server does not answer", async () => {
    const { server, guard, checks, losses } = guarded(false);
    await guard.sql`SELECT 1`;
    server.stalled = true;
    const stalled = outcome(guard.sql`SELECT 1`);
    const transaction = outcome(guard.sql.begin(async (tx) => tx`SELECT 1`));

    expect(await stalled).toBe("rejected: Connection closed");
    expect(await transaction).toBe("rejected: Connection closed");
    expect(checks()).toBe(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.message).toContain(`unanswered for ${STALL_MS} ms`);
    expect(server.pools.map((pool) => pool.closed())).toEqual([true, false]);

    server.stalled = false;
    expect(await guard.sql<{ ok: number }[]>`SELECT 1`).toEqual([{ ok: 1 }]);
  });

  it("keeps a slow query running while the server answers", async () => {
    const { server, guard, checks, losses } = guarded(true);
    await guard.sql`SELECT 1`;
    server.stalled = true;
    const slow = outcome(guard.sql`SELECT 1`);
    await pause(STALL_MS * 3);

    expect(checks()).toBe(1);
    server.pools[0]?.resume();
    expect(await slow).toBe("resolved");
    expect(losses).toHaveLength(0);
    expect(server.pools).toHaveLength(1);
  });

  it("checks the server once for queries that stall together", async () => {
    const { server, guard, checks, losses } = guarded(false);
    await guard.sql`SELECT 1`;
    server.stalled = true;
    const results = await Promise.all([1, 2, 3].map(() => outcome(guard.sql`SELECT 1`)));

    expect(results).toEqual(Array(3).fill("rejected: Connection closed"));
    expect(checks()).toBe(1);
    expect(losses).toHaveLength(1);
    expect(server.pools).toHaveLength(2);
  });

  it("leaves a pool that never answered to the connection timeout", async () => {
    const { server, guard, checks } = guarded(false);
    server.stalled = true;
    const pending = guard.sql`SELECT 1`;
    void pending.then(undefined, () => undefined);
    await pause(STALL_MS * 3);

    expect(checks()).toBe(0);
    expect(server.pools).toHaveLength(1);
    server.pools[0]?.resume();
  });

  it("starts the clock only when a query runs, not when it is built", async () => {
    const { server, guard, checks } = guarded(false);
    await guard.sql`SELECT 1`;
    server.stalled = true;
    guard.sql`WHERE true`;
    await pause(STALL_MS * 3);

    expect(checks()).toBe(0);
    expect(server.pools).toHaveLength(1);
  });
});

describe("answersOnNewConnection", () => {
  it("reports a server that accepts the connection but never answers", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const startedAt = Date.now();
      expect(await answersOnNewConnection(`postgres://podokit:podokit@127.0.0.1:${server.port}/podokit`, 200)).toBe(
        false,
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });
});
