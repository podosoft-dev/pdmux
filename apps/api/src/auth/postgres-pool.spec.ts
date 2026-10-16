import { describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import type { PoolClient } from "pg";
import { AuthPostgresPool } from "./postgres-pool";

interface FakePostgres {
  port: number;
  /** While false, the server keeps every connection open and ignores queries, like a paused one. */
  answering: boolean;
  accepted: number;
  closed: number;
  stop: () => void;
}

function message(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

const AUTHENTICATION_OK = message("R", Buffer.from([0, 0, 0, 0]));
const READY_FOR_QUERY = message("Z", Buffer.from("I"));
const SELECT_DONE = Buffer.concat([message("C", Buffer.from("SELECT 0\0")), READY_FOR_QUERY]);

/** Speaks enough of the PostgreSQL protocol for pg to connect and run simple queries. */
function fakePostgres(): FakePostgres {
  const started = new WeakSet<Socket<undefined>>();
  const server: FakePostgres = { port: 0, answering: true, accepted: 0, closed: 0, stop: () => undefined };
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        server.accepted += 1;
      },
      close() {
        server.closed += 1;
      },
      data(socket, data) {
        if (!started.has(socket)) {
          started.add(socket);
          socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
          return;
        }
        if (server.answering && data[0] === "Q".charCodeAt(0)) socket.write(SELECT_DONE);
      },
    },
  });
  server.port = listener.port;
  server.stop = () => listener.stop(true);
  return server;
}

function poolFor(server: FakePostgres): AuthPostgresPool {
  return new AuthPostgresPool({
    host: "127.0.0.1",
    port: server.port,
    user: "podokit",
    database: "podokit",
    max: 1,
    query_timeout: 50,
  });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AuthPostgresPool", () => {
  it("keeps a client whose queries were answered", async () => {
    const server = fakePostgres();
    const pool = poolFor(server);
    try {
      for (let round = 0; round < 2; round += 1) {
        const client = await pool.connect();
        await client.query("SELECT 1");
        client.release();
      }
      expect(server.accepted).toBe(1);
      expect(pool.idleCount).toBe(1);
    } finally {
      await pool.end();
      server.stop();
    }
  });

  it("discards a client released while its query still waits for the reply", async () => {
    const server = fakePostgres();
    const pool = poolFor(server);
    try {
      const client = await pool.connect();
      server.answering = false;
      await expect(client.query("SELECT 1")).rejects.toThrow("Query read timeout");
      client.release();

      expect(pool.totalCount).toBe(0);
      await until(() => server.closed === 1);

      server.answering = true;
      const next = await pool.connect();
      await next.query("SELECT 1");
      next.release();
      expect(server.accepted).toBe(2);
      expect(pool.idleCount).toBe(1);
    } finally {
      await pool.end();
      server.stop();
    }
  });

  it("discards the client through the callback form and Pool.query", async () => {
    const server = fakePostgres();
    const pool = poolFor(server);
    try {
      server.answering = false;
      await expect(pool.query("SELECT 1")).rejects.toThrow("Query read timeout");
      expect(pool.totalCount).toBe(0);

      const client = await new Promise<PoolClient>((resolve, reject) => {
        pool.connect((error, connected) => (connected ? resolve(connected) : reject(error)));
      });
      await expect(client.query("SELECT 1")).rejects.toThrow("Query read timeout");
      client.release();
      expect(pool.totalCount).toBe(0);
      await until(() => server.closed === 2);
    } finally {
      await pool.end();
      server.stop();
    }
  });
});
