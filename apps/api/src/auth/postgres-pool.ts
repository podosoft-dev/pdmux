import { Pool, type PoolClient } from "pg";

type ConnectCallback = Parameters<Pool["connect"]>[0];

/** Whether `client` still waits for the reply to a query; pg sets `readyForQuery` once the server is ready for the next one. */
function awaitingReply(client: PoolClient): boolean {
  return Reflect.get(client, "readyForQuery") === false;
}

function discardWhileAwaitingReply(client: PoolClient): PoolClient {
  const release = client.release;
  client.release = (error?: Error | boolean): void => {
    release.call(
      client,
      error || (awaitingReply(client) ? new Error("Released while waiting for a query reply") : undefined),
    );
  };
  return client;
}

/**
 * pg fails a query after `query_timeout` but leaves the connection waiting for
 * the reply. `Pool.query` discards that client, but Kysely, which Better Auth
 * runs on, releases it as healthy, so the pool would hand it out again and
 * every later query on it would queue behind the missing reply. This pool
 * discards a client released while it still waits for a reply: pg closes its
 * socket, and the next query gets a new connection.
 */
export class AuthPostgresPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    if (!callback) return super.connect().then(discardWhileAwaitingReply);
    super.connect((error, client, done) => {
      if (!client) return callback(error, client, done);
      const guarded = discardWhileAwaitingReply(client);
      callback(error, guarded, guarded.release);
    });
  }
}
