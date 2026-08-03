import type { IncomingMessage } from "node:http";

/**
 * Who is actually on the other end of a request.
 *
 * ⚠ `req.ip` IS THE WEB TIER, NOT THE CALLER. The API sits behind SvelteKit, which
 * rewrites `x-forwarded-for` to the address it resolved (`backend-proxy.ts`), and
 * Express `trust proxy` is deliberately NOT enabled here — so the header has to be
 * read first. The throttler guard already makes the same choice when it decides
 * whose quota to spend; this is the same rule, in one place, because two copies of
 * it drift into two different answers for the same connection.
 *
 * Takes an `IncomingMessage` rather than an Express `Request` so the WebSocket
 * upgrade path can use it too: an upgrade never reaches Express, so there is no
 * `req.ip` there at all and the socket's own peer address is the last resort.
 */
export function clientIp(req: IncomingMessage & { ip?: string | undefined }): string | null {
  const header = req.headers["x-forwarded-for"];
  const first = Array.isArray(header) ? header[0] : header;
  const forwarded = typeof first === "string" ? first.split(",")[0]?.trim() : undefined;
  return forwarded || req.ip || req.socket?.remoteAddress || null;
}
