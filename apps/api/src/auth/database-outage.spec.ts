import { describe, expect, it, mock } from "bun:test";
import { APIError } from "better-auth/api";
import { Pool } from "pg";
import {
  answersWithin,
  checkAuthResponse,
  rethrowAuthError,
  sharedProbe,
} from "./database-outage";

const down = mock(async () => false);
const up = mock(async () => true);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("checkAuthResponse", () => {
  it("passes answers below 500 on without asking the database", async () => {
    const probe = mock(async () => false);
    for (const status of [200, 401, 403, 429]) {
      const response = new Response(null, { status });
      await expect(checkAuthResponse(response, probe)).resolves.toBe(response);
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps a server error while the database answers", async () => {
    const response = new Response(null, { status: 500 });
    await expect(checkAuthResponse(response, up)).resolves.toBe(response);
  });

  it("reports a server error during a database outage as DATABASE_UNAVAILABLE", async () => {
    const error = await rejection(checkAuthResponse(new Response(null, { status: 500 }), down));
    expect(error).toMatchObject({ code: "DATABASE_UNAVAILABLE", statusCode: 503 });
  });
});

describe("rethrowAuthError", () => {
  it("rethrows client errors without asking the database", async () => {
    const probe = mock(async () => false);
    const unauthorized = new APIError("UNAUTHORIZED", { message: "Invalid session" });
    await expect(rejection(rethrowAuthError(unauthorized, probe))).resolves.toBe(unauthorized);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports a server error during a database outage as DATABASE_UNAVAILABLE", async () => {
    const failed = APIError.from("INTERNAL_SERVER_ERROR", { message: "Failed to get session", code: "FAILED_TO_GET_SESSION" });
    const error = await rejection(rethrowAuthError(failed, down));
    expect(error).toMatchObject({ code: "DATABASE_UNAVAILABLE", statusCode: 503 });
    expect(await rejection(rethrowAuthError(new Error("socket hang up"), down)))
      .toMatchObject({ code: "DATABASE_UNAVAILABLE" });
  });

  it("rethrows other server errors unchanged while the database answers", async () => {
    const failure = new Error("Unexpected");
    await expect(rejection(rethrowAuthError(failure, up))).resolves.toBe(failure);
  });
});

describe("answersWithin", () => {
  it("reports success and failure of the query", async () => {
    await expect(answersWithin(async () => [{ ok: 1 }], 100)).resolves.toBe(true);
    await expect(answersWithin(async () => { throw new Error("refused"); }, 100)).resolves.toBe(false);
  });

  it("gives up on a query that does not answer", async () => {
    const started = Date.now();
    await expect(answersWithin(() => new Promise(() => undefined), 50)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a PostgreSQL server that refuses or never answers as unreachable", async () => {
    // Accepts the TCP connection and never answers, like a paused server.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    closed.stop(true);
    const pools = [silent.port, closed.port].map((port) =>
      new Pool({
        connectionString: `postgres://podokit:podokit@127.0.0.1:${port}/podokit`,
        connectionTimeoutMillis: 2_000,
      })
    );
    try {
      for (const pool of pools) {
        const started = Date.now();
        await expect(answersWithin(() => pool.query("SELECT 1"), 200)).resolves.toBe(false);
        expect(Date.now() - started).toBeLessThan(1_000);
      }
    } finally {
      silent.stop(true);
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
    }
  });
});

describe("sharedProbe", () => {
  it("lets concurrent callers share one probe and probes again afterwards", async () => {
    let release: (value: boolean) => void = () => undefined;
    const probe = mock(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const shared = sharedProbe(probe);

    const first = shared();
    const second = shared();
    release(false);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(probe).toHaveBeenCalledTimes(1);

    const third = shared();
    release(true);
    await expect(third).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
