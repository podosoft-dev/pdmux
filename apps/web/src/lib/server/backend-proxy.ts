import { APP_BODY_LIMITS } from "./body-limits";
import { APP_FORWARDED_REQUEST_HEADERS, APP_RELAYED_RESPONSE_HEADERS } from "./proxy-headers";

// Server-side proxy boundary. The browser never talks to the API directly:
// requests go through SvelteKit server routes, which forward an allowlist of
// headers to BACKEND_INTERNAL_URL and relay the response (including Set-Cookie).
// Applications add their own header names in the app-owned proxy-headers.ts.
//
// `user-agent` is on the list for the same reason the client IP is forwarded
// below: better-auth records it on the session and the account page shows it as
// the device. Leaving it off does not produce an empty column -- fetch supplies
// its own default, so every session in the database reads "node", and the list
// of "your devices" becomes a list of identical rows that identify nothing.
const FORWARDED_HEADERS = [
  "authorization",
  "cookie",
  "content-type",
  "accept",
  "origin",
  "referer",
  "user-agent",
  "if-none-match",
  "if-modified-since",
  "range",
  "if-range",
];
const RELAYED_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "location",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
  "x-content-type-options",
  "content-security-policy",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  // Cursor-paged lists (such as the audit log) return the next page's cursor here.
  "x-next-cursor",
];

// Hop-by-hop headers describe a single connection, and the proxy sets framing,
// cookies, and the client address itself, so application lists cannot add these.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const RESERVED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);
const RESERVED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-length",
  "content-encoding",
  "set-cookie",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
/** Larger response bodies stream through; smaller ones are relayed with their length. */
export const IN_MEMORY_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Append an application's header names to a built-in list, lowercased and
 *  without duplicates. Throws on an invalid or reserved name so a mistake fails
 *  the build instead of silently dropping the header. */
export function withAppHeaders(
  builtIn: readonly string[],
  app: readonly string[],
  reserved: ReadonlySet<string>,
  listName: string,
): string[] {
  const names = new Set(builtIn);
  for (const entry of app) {
    const name = entry.toLowerCase();
    if (!HEADER_NAME.test(name)) {
      throw new Error(`${listName} contains an invalid header name: ${JSON.stringify(entry)}`);
    }
    if (reserved.has(name)) {
      throw new Error(`${listName} cannot contain "${name}": the proxy handles that header itself.`);
    }
    names.add(name);
  }
  return [...names];
}

const forwardedHeaders = withAppHeaders(
  FORWARDED_HEADERS,
  APP_FORWARDED_REQUEST_HEADERS,
  RESERVED_REQUEST_HEADERS,
  "APP_FORWARDED_REQUEST_HEADERS",
);
const relayedResponseHeaders = withAppHeaders(
  RELAYED_RESPONSE_HEADERS,
  APP_RELAYED_RESPONSE_HEADERS,
  RESERVED_RESPONSE_HEADERS,
  "APP_RELAYED_RESPONSE_HEADERS",
);

export interface BodyLimit {
  pathPrefix: string;
  maxBytes: number;
}

const BODY_LIMIT_PREFIX = /^\/api(?:\/[A-Za-z0-9._~!$&'()+,;=:@-]+)*\/?$/;

/** Validate application body limits and order them so the longest prefix
 *  matches first. Prefixes are stored without a trailing slash. */
export function sortedBodyLimits(limits: ReadonlyArray<BodyLimit>): BodyLimit[] {
  const seen = new Set<string>();
  const sorted = limits.map(({ pathPrefix, maxBytes }) => {
    if (
      !BODY_LIMIT_PREFIX.test(pathPrefix) ||
      pathPrefix.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(
        `APP_BODY_LIMITS pathPrefix must be a static path under /api/, such as "/api/feedback/": ${JSON.stringify(pathPrefix)}`,
      );
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error(`APP_BODY_LIMITS maxBytes for ${pathPrefix} must be a positive whole number of bytes.`);
    }
    const base = pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix;
    if (seen.has(base)) throw new Error(`APP_BODY_LIMITS lists ${pathPrefix} more than once.`);
    seen.add(base);
    return { pathPrefix: base, maxBytes };
  });
  return sorted.sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);
}

const bodyLimits = sortedBodyLimits(APP_BODY_LIMITS);

/** The body limit for a request path, matched on the decoded path so an encoded
 *  segment cannot step around a prefix. */
export function bodyLimitFor(pathname: string, limits: readonly BodyLimit[] = bodyLimits): number | undefined {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path when it holds a malformed escape.
  }
  return limits.find(
    ({ pathPrefix }) => path === pathPrefix || path.startsWith(`${pathPrefix}/`),
  )?.maxBytes;
}

/** Read a request body, or return null as soon as it exceeds maxBytes. The rest
 *  of an oversized body is never buffered. */
async function readLimitedBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function payloadTooLarge(path: string, maxBytes: number): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: `Request body exceeds the ${maxBytes}-byte limit for this route`,
        statusCode: 413,
        path,
        timestamp: new Date().toISOString(),
        details: { maxBytes },
      },
    },
    { status: 413 },
  );
}

// SvelteKit decodes rest params, so an encoded "%2F" or "%3F" inside a path
// segment would reach the API as "/" or "?". Forward the raw pathname instead.
export function rawSubpath(url: URL, prefix: string): string {
  return url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
}

export function backendBaseUrl(): string {
  return process.env.BACKEND_INTERNAL_URL ?? "http://localhost:5002";
}

/**
 * Milliseconds one server-side API call may take, response body included, and
 * how long the proxy waits for response headers before it checks whether the
 * API still answers at all.
 */
const DEFAULT_BACKEND_TIMEOUT_MS = 2_000;
/**
 * Milliseconds the proxy waits for the API's response headers, matching the
 * API's default idle timeout. Streamed bodies are not cut off once they start.
 */
const DEFAULT_BACKEND_PROXY_TIMEOUT_MS = 30_000;
/** Seconds between checks while the API is unreachable, also sent as Retry-After. */
const BACKEND_RETRY_AFTER_SECONDS = 2;
const MAX_TIMER_MS = 2_147_483_647;

/** A whole number of milliseconds from the environment, or the default when unset or empty. */
export function envMilliseconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(
      `${name} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}: ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function backendTimeoutMs(): number {
  return envMilliseconds("BACKEND_TIMEOUT_MS", DEFAULT_BACKEND_TIMEOUT_MS);
}

function backendProxyTimeoutMs(): number {
  return envMilliseconds("BACKEND_PROXY_TIMEOUT_MS", DEFAULT_BACKEND_PROXY_TIMEOUT_MS);
}

// An invalid value stops the server when this module loads instead of failing
// every request that reads it.
backendTimeoutMs();
backendProxyTimeoutMs();

// The API counts as unreachable only when GET /health gets no HTTP answer
// within BACKEND_TIMEOUT_MS. It is checked when a request gets no answer, or
// when the proxy waits longer than that for response headers, so one slow
// endpoint does not fail every request in the process. Once the API is found
// unreachable, requests still waiting for it fail, new ones fail at once instead
// of each waiting for a refused connection, a DNS lookup, or a hung server, and
// a background check runs at most every BACKEND_RETRY_AFTER_SECONDS. Any HTTP
// answer, including an error status, means the API is reachable.
let unreachable = false;
let answers = 0;
let lastCheckEnded = 0;
let pendingCheck: Promise<void> | undefined;
let outage = new AbortController();

/** Aborts when the API is found unreachable, failing the requests that still wait for it. */
export function backendOutageSignal(): AbortSignal {
  return outage.signal;
}

/** Check whether the API answers at all. Concurrent callers share one check. */
export function checkBackend(): Promise<void> {
  if (!pendingCheck) {
    const answersBefore = answers;
    pendingCheck = fetch(`${backendBaseUrl()}/health`, { signal: AbortSignal.timeout(backendTimeoutMs()) })
      .then(
        (response) => {
          reportBackendAnswer();
          return response.body?.cancel().catch(() => undefined);
        },
        () => {
          if (answers !== answersBefore) return;
          unreachable = true;
          outage.abort(new DOMException("The API is unavailable", "AbortError"));
          outage = new AbortController();
        },
      )
      .finally(() => {
        lastCheckEnded = Date.now();
        pendingCheck = undefined;
      });
  }
  return pendingCheck;
}

/** Record an HTTP answer from the API, whatever its status. */
export function reportBackendAnswer(): void {
  answers += 1;
  unreachable = false;
}

/** Record a request that got no HTTP answer, and check the API unless it is already known to be down. */
export function reportBackendFailure(): Promise<void> {
  return unreachable ? Promise.resolve() : checkBackend();
}

/**
 * False while the API is known to be unreachable. Such a call also starts a
 * background check when none ran in the last BACKEND_RETRY_AFTER_SECONDS.
 */
export function backendReachable(now = Date.now()): boolean {
  if (!unreachable) return true;
  if (!pendingCheck && now - lastCheckEnded >= BACKEND_RETRY_AFTER_SECONDS * 1000) void checkBackend();
  return false;
}

function backendFailure(path: string, statusCode: 503 | 504): Response {
  const timedOut = statusCode === 504;
  return Response.json(
    {
      success: false,
      error: {
        code: timedOut ? "BACKEND_TIMEOUT" : "BACKEND_UNAVAILABLE",
        message: timedOut ? "The API did not respond in time" : "The API is unavailable",
        statusCode,
        path,
        timestamp: new Date().toISOString(),
      },
    },
    {
      status: statusCode,
      headers: {
        "cache-control": "no-store",
        ...(timedOut ? {} : { "retry-after": String(BACKEND_RETRY_AFTER_SECONDS) }),
      },
    },
  );
}

// Normalize the resolved client IP for the forwarded header. better-auth stores
// IPv4 as-is but anonymizes IPv6 (masks the host bits), so an IPv6 loopback would
// be recorded as "::" — map loopback to 127.0.0.1 for a clean local value, and
// unwrap IPv4-mapped addresses.
export function normalizeClientIp(address: string | undefined): string | undefined {
  if (!address) return undefined;
  if (address === "::1" || address === "::") return "127.0.0.1";
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
  return address;
}

export function resolveClientIp(getClientAddress: () => string): string | undefined {
  try {
    return normalizeClientIp(getClientAddress());
  } catch {
    // An absent or shorter-than-configured proxy chain is not a trusted source.
    return undefined;
  }
}

export async function proxyRequest(
  request: Request,
  targetUrl: string,
  clientAddress?: string,
  server?: { timeout(request: Request, seconds: number): void },
): Promise<Response> {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Forward the resolved client IP so the API (better-auth) can record it.
  const forwardedIp = normalizeClientIp(clientAddress);
  if (forwardedIp) headers.set("x-forwarded-for", forwardedIp);
  // ⚠ AND THE ORIGIN THE CALLER ACTUALLY REACHED. Without these the API sees only
  // its own container name, and anything it builds an absolute URL from — the MCP
  // endpoint's install command is the case that caught this — hands out an address
  // that resolves nowhere outside the compose network.
  try {
    const incoming = new URL(request.url);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  } catch {
    // A request without a parseable URL cannot happen through SvelteKit; if it
    // ever does, the API falls back to its own host rather than failing.
  }

  const { pathname } = new URL(request.url);
  if (!backendReachable()) {
    request.body?.cancel().catch(() => undefined);
    return backendFailure(pathname, 503);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const transfer = /\/file-transfers(?:\/|$)/.test(pathname);
  if (transfer) server?.timeout(request, 60);
  let body: ArrayBuffer | Uint8Array<ArrayBuffer> | undefined;
  if (hasBody && /\/file-transfers\/[^/]+\/entries\/[^/]+\/chunk$/.test(pathname)) {
    const reader = request.body?.getReader();
    const bytes = new Uint8Array(1_048_576);
    let offset = 0;
    if (reader) try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.byteLength > bytes.length) {
          await reader.cancel();
          return Response.json({ success: false, error: { code: "FILES_TRANSFER_CHUNK", message: "Chunk exceeds the limit", statusCode: 413,
            path: pathname, timestamp: new Date().toISOString() } }, { status: 413 });
        }
        bytes.set(next.value, offset);
        offset += next.value.byteLength;
      }
    } finally { reader.releaseLock(); }
    body = bytes.subarray(0, offset);
  } else if (hasBody) {
    // Preserve multipart uploads and other binary bodies byte-for-byte. Reading
    // them as text corrupts bytes that are not valid UTF-8 before forwarding.
    const maxBytes = bodyLimitFor(pathname);
    if (maxBytes === undefined) {
      body = await request.arrayBuffer();
    } else {
      const limited = await readLimitedBody(request, maxBytes);
      if (limited === null) return payloadTooLarge(pathname, maxBytes);
      body = limited;
    }
  }
  // The API's agent deadline owns this wait. Bun's default ten-second idle
  // timeout must not reset a request that is verifying a large staged file.
  if (transfer) server?.timeout(request, 0);
  // The deadline, the health check, and the outage signal cover only the wait
  // for response headers, so streamed bodies such as server-sent events are not
  // cut off.
  // ⚠ A FILE TRANSFER HAS NO PROXY DEADLINE, for the reason it has no idle
  // timeout: a commit waits up to five minutes for the agent to verify the
  // staged file, and every transfer request queues behind the host's lock, so a
  // 504 would fail a transfer the API then completes. The health check and the
  // outage signal still fail it when the API stops answering.
  const waiting = new AbortController();
  const deadline = transfer
    ? undefined
    : setTimeout(
        () => waiting.abort(new DOMException("The API did not respond in time", "TimeoutError")),
        backendProxyTimeoutMs(),
      );
  const healthCheck = setTimeout(() => void checkBackend(), backendTimeoutMs());
  const outage = backendOutageSignal();
  const failOnOutage = (): void => waiting.abort(outage.reason);
  outage.addEventListener("abort", failOnOutage);
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      // Abort the upstream request when the browser disconnects. Without this, every
      // closed EventSource or aborted request keeps its API socket open until Bun's
      // fetch pool is exhausted and the web process stops serving requests.
      signal: AbortSignal.any([request.signal, waiting.signal]),
    });
  } catch (cause: unknown) {
    // Nobody waits for an answer to a request the browser abandoned.
    if (request.signal.aborted) throw cause;
    if (outage.aborted) return backendFailure(pathname, 503);
    void reportBackendFailure();
    return backendFailure(pathname, waiting.signal.aborted ? 504 : 503);
  } finally {
    clearTimeout(deadline);
    clearTimeout(healthCheck);
    outage.removeEventListener("abort", failOnOutage);
  }
  reportBackendAnswer();

  const responseHeaders = new Headers();
  for (const name of relayedResponseHeaders) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Bun's fetch decodes a compressed body but keeps the upstream content-encoding
  // and compressed content-length, which would truncate the decoded body.
  const contentLength = upstream.headers.get("content-length");
  const relayedLength = contentLength && !upstream.headers.has("content-encoding") ? contentLength : null;
  if (relayedLength) responseHeaders.set("content-length", relayedLength);
  // Relay Set-Cookie so auth session cookies reach the browser.
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }

  // Bun sends a streamed body with chunked encoding and drops its content-length
  // unless the body is in memory, so a body of modest, known size is read first.
  const relayedBody = relayedLength && upstream.body && Number(relayedLength) <= IN_MEMORY_RESPONSE_BYTES
    ? await upstream.arrayBuffer()
    : upstream.body;
  return new Response(relayedBody, { status: upstream.status, headers: responseHeaders });
}
