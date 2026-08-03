import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Helpers shared by the two WebSocket entry points (agent gateway, terminal relay).
 *
 * Both live on the same HTTP server and each handles only its own path, so a
 * handler must be able to say "not mine" without consuming the socket.
 */

/** Path of an upgrade request, without the query string. */
export function upgradePath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

/** Query parameters of an upgrade request. */
export function upgradeQuery(req: IncomingMessage): URLSearchParams {
  const [, query = ""] = (req.url ?? "/").split("?");
  return new URLSearchParams(query);
}

/**
 * Answer an upgrade with a real HTTP status instead of silently dropping the
 * socket — a client that gets nothing cannot tell "wrong credentials" from
 * "server down", and retries forever.
 */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const text = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  try {
    socket.write(text);
  } catch {
    // Peer already gone.
  }
  socket.destroy();
}
