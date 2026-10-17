import { APP_BODY_LIMITS } from "./body-limits";
import { APP_FORWARDED_REQUEST_HEADERS, APP_RELAYED_RESPONSE_HEADERS } from "./proxy-headers";
import { APP_PROXY_TIMEOUTS } from "./proxy-timeouts";

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

/** A literal path segment, or null for a `:name` parameter. */
type PathSegment = string | null;

/** An application path rule with its prefix split into segments. */
export type PathRule<T extends { pathPrefix: string }> = T & { readonly segments: readonly PathSegment[] };

const LITERAL_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=:@-]+$/;
const PARAMETER_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;

/** The segments of a prefix under /api/, or undefined when it is not one. */
function parsePathPrefix(pathPrefix: string): PathSegment[] | undefined {
  const base = pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix;
  const [root, ...segments] = base.split("/");
  if (root !== "" || segments[0] !== "api") return undefined;
  const parsed: PathSegment[] = [];
  for (const segment of segments) {
    if (PARAMETER_SEGMENT.test(segment)) {
      parsed.push(null);
    } else if (LITERAL_SEGMENT.test(segment) && !segment.startsWith(":") && segment !== "." && segment !== "..") {
      parsed.push(segment);
    } else {
      return undefined;
    }
  }
  return parsed;
}

/**
 * Below zero when `a` is more specific: more segments, then, from the left, a
 * literal segment before a parameter.
 */
function compareSpecificity(a: readonly PathSegment[], b: readonly PathSegment[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let index = 0; index < a.length; index += 1) {
    const literal = a[index] !== null;
    if (literal !== (b[index] !== null)) return literal ? -1 : 1;
  }
  return 0;
}

/** Validate an application list of /api path prefixes and order it so the
 *  most specific prefix matches first. Prefixes are stored without a trailing
 *  slash. */
function sortedByPrefix<T extends { pathPrefix: string }>(
  entries: ReadonlyArray<T>,
  listName: string,
  example: string,
  check: (entry: T) => void,
): PathRule<T>[] {
  const seen = new Map<string, string>();
  const rules = entries.map((entry) => {
    const { pathPrefix } = entry;
    const segments = parsePathPrefix(pathPrefix);
    if (!segments) {
      throw new Error(
        `${listName} pathPrefix must be a path under /api/ made of literal segments and ":name" parameters, ` +
          `such as "${example}": ${JSON.stringify(pathPrefix)}`,
      );
    }
    check(entry);
    // Parameter names do not change which paths a prefix covers.
    const key = segments.map((segment) => segment ?? ":").join("/");
    const listed = seen.get(key);
    if (listed !== undefined) {
      throw new Error(
        `${listName} lists the same paths twice: ${JSON.stringify(listed)} and ${JSON.stringify(pathPrefix)}.`,
      );
    }
    seen.set(key, pathPrefix);
    return { ...entry, pathPrefix: pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix, segments };
  });
  return rules.sort((left, right) => compareSpecificity(left.segments, right.segments));
}

/** The most specific rule for a request path. Prefixes match whole segments of
 *  the decoded path, so an encoded segment cannot step around them, and a
 *  parameter matches exactly one non-empty segment. */
function entryFor<T extends { pathPrefix: string }>(
  pathname: string,
  rules: readonly PathRule<T>[],
): PathRule<T> | undefined {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path when it holds a malformed escape.
  }
  const segments = path.split("/").slice(1);
  return rules.find(
    (rule) =>
      rule.segments.length <= segments.length &&
      rule.segments.every((segment, index) =>
        segment === null ? segments[index] !== "" : segment === segments[index],
      ),
  );
}

export function sortedBodyLimits(limits: ReadonlyArray<BodyLimit>): PathRule<BodyLimit>[] {
  return sortedByPrefix(limits, "APP_BODY_LIMITS", "/api/feedback/", ({ pathPrefix, maxBytes }) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error(`APP_BODY_LIMITS maxBytes for ${pathPrefix} must be a positive whole number of bytes.`);
    }
  });
}

const bodyLimits = sortedBodyLimits(APP_BODY_LIMITS);

export function bodyLimitFor(pathname: string, limits: readonly PathRule<BodyLimit>[] = bodyLimits): number | undefined {
  return entryFor(pathname, limits)?.maxBytes;
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
 * how often the proxy checks whether the API still answers at all while it waits
 * for response headers.
 */
const DEFAULT_BACKEND_TIMEOUT_MS = 2_000;
/**
 * Milliseconds the proxy waits for the API's response headers, unless
 * APP_PROXY_TIMEOUTS lists the path. The API's default idle timeout of 35
 * seconds outlasts it.
 * Streamed bodies are not cut off once they start.
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

export interface ProxyTimeout {
  pathPrefix: string;
  /** Milliseconds to wait for response headers, or null for no deadline. */
  timeoutMs: number | null;
}

export function sortedProxyTimeouts(timeouts: ReadonlyArray<ProxyTimeout>): PathRule<ProxyTimeout>[] {
  return sortedByPrefix(timeouts, "APP_PROXY_TIMEOUTS", "/api/exports/", ({ pathPrefix, timeoutMs }) => {
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS)) {
      throw new Error(
        `APP_PROXY_TIMEOUTS timeoutMs for ${pathPrefix} must be null or a whole number of milliseconds from 1 to ${MAX_TIMER_MS}.`,
      );
    }
  });
}

const proxyTimeouts = sortedProxyTimeouts(APP_PROXY_TIMEOUTS);

/** How long the proxy waits for response headers on a request path, or null for no deadline. */
export function proxyTimeoutFor(
  pathname: string,
  timeouts: readonly PathRule<ProxyTimeout>[] = proxyTimeouts,
): number | null {
  const entry = entryFor(pathname, timeouts);
  return entry ? entry.timeoutMs : backendProxyTimeoutMs();
}

/**
 * Bun's fetch fails a request whose connection sends nothing for its idle
 * timeout, 300 seconds unless BUN_CONFIG_HTTP_IDLE_TIMEOUT sets another, even
 * while the proxy still waits for response headers.
 */
const FETCH_IDLE_TIMEOUT_MS = 300_000;

/**
 * Bun's fetch options for a request that waits up to timeoutMs for response
 * headers. A wait without a deadline, or one Bun's idle timeout would cut
 * first, turns that timeout off, so only the deadline, the health checks, and
 * the browser end it. Shorter waits keep Bun's default.
 */
export function upstreamFetchOptions(timeoutMs: number | null): { timeout?: false } {
  return timeoutMs === null || timeoutMs >= FETCH_IDLE_TIMEOUT_MS ? { timeout: false } : {};
}

/** Bun closes silent connections on a 4-second tick, up to 4 seconds before their idle timeout. */
const IDLE_TICK_SECONDS = 4;
/** The longest idle timeout Bun accepts; 0 turns it off. */
const MAX_IDLE_TIMEOUT_SECONDS = 255;

/**
 * Throw unless the web server keeps a silent connection open longer than the
 * proxy waits for response headers. adapter-bun takes its idle timeout from
 * CONNECTION_IDLE_TIMEOUT (Bun's 10 seconds when unset) and closes a connection
 * that sends nothing for that long without a response, so neither the API's late
 * answer nor the proxy's 504 would reach the browser.
 */
export function checkIdleTimeout(
  idleTimeout: string | undefined,
  defaultTimeoutMs: number,
  timeouts: readonly ProxyTimeout[],
): void {
  // adapter-bun rejects a malformed value itself when it starts.
  if (idleTimeout === undefined || !/^\d+$/.test(idleTimeout) || Number(idleTimeout) === 0) return;
  let longest: { timeoutMs: number | null; source: string } = {
    timeoutMs: defaultTimeoutMs,
    source: "BACKEND_PROXY_TIMEOUT_MS",
  };
  for (const { pathPrefix, timeoutMs } of timeouts) {
    if (longest.timeoutMs !== null && (timeoutMs === null || timeoutMs > longest.timeoutMs)) {
      longest = { timeoutMs, source: `APP_PROXY_TIMEOUTS for ${pathPrefix}` };
    }
  }
  const seconds = Number(idleTimeout);
  if (longest.timeoutMs !== null && (seconds - IDLE_TICK_SECONDS) * 1000 > longest.timeoutMs) return;
  const minimum =
    longest.timeoutMs === null ? Infinity : Math.floor(longest.timeoutMs / 1000) + IDLE_TICK_SECONDS + 1;
  const wait = longest.timeoutMs === null ? "no deadline" : `${longest.timeoutMs} ms`;
  const fix =
    minimum <= MAX_IDLE_TIMEOUT_SECONDS
      ? `at least ${minimum}, or to 0 to turn the idle timeout off`
      : `0 to turn the idle timeout off, since Bun allows at most ${MAX_IDLE_TIMEOUT_SECONDS} seconds`;
  throw new Error(
    `CONNECTION_IDLE_TIMEOUT=${seconds} lets the web server close a silent connection before the /api proxy ` +
      `stops waiting for response headers (${wait}, ${longest.source}); Bun closes idle connections up to ` +
      `${IDLE_TICK_SECONDS} seconds early. Set CONNECTION_IDLE_TIMEOUT to ${fix}.`,
  );
}

checkIdleTimeout(process.env.CONNECTION_IDLE_TIMEOUT, backendProxyTimeoutMs(), proxyTimeouts);

// The API counts as unreachable only when GET /health gets no HTTP answer
// within BACKEND_TIMEOUT_MS. It is checked when a request gets no answer, and
// every BACKEND_TIMEOUT_MS while the proxy waits for response headers, so one
// slow endpoint does not fail every request in the process, while an API that
// stops answering still ends a long or unbounded wait. Once the API is found
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

/** Check the API unless a check is running or one ended within BACKEND_TIMEOUT_MS. */
function recheckBackend(now = Date.now()): void {
  if (!pendingCheck && now - lastCheckEnded >= backendTimeoutMs()) void checkBackend();
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

let publicOriginsSource: string | undefined;
let publicOrigins: ReadonlySet<string> = new Set();

/**
 * The public web origins listed in CORS_ORIGIN. Wildcard patterns name no single
 * origin and are skipped, as are entries that are not absolute URLs.
 */
export function configuredPublicOrigins(value = process.env.CORS_ORIGIN): ReadonlySet<string> {
  if (value !== publicOriginsSource) {
    publicOriginsSource = value;
    publicOrigins = new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => !entry.includes("*") && URL.canParse(entry))
        .map((entry) => new URL(entry).origin),
    );
  }
  return publicOrigins;
}

/**
 * Tell the API which public origin a request came in on. SvelteKit resolves the
 * request URL from the Host header, or from the gateway's forwarded headers that
 * HOST_HEADER and PROTOCOL_HEADER name, so the value is sent only when that origin
 * is listed in CORS_ORIGIN. The API can then build links for the origin a browser
 * used without trusting a header a caller wrote.
 */
export function setForwardedOrigin(headers: Headers, url: URL): void {
  if (!configuredPublicOrigins().has(url.origin)) return;
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
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
): Promise<Response> {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Forward the resolved client IP so the API (better-auth) can record it.
  const forwardedIp = normalizeClientIp(clientAddress);
  if (forwardedIp) headers.set("x-forwarded-for", forwardedIp);
  const requestUrl = new URL(request.url);
  setForwardedOrigin(headers, requestUrl);

  const { pathname } = requestUrl;
  if (!backendReachable()) {
    request.body?.cancel().catch(() => undefined);
    return backendFailure(pathname, 503);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (hasBody) {
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
  // The deadline, the health checks, and the outage signal cover only the wait
  // for response headers, so streamed bodies such as server-sent events are not
  // cut off.
  const waiting = new AbortController();
  const timeoutMs = proxyTimeoutFor(pathname);
  const deadline =
    timeoutMs === null
      ? undefined
      : setTimeout(
          () => waiting.abort(new DOMException("The API did not respond in time", "TimeoutError")),
          timeoutMs,
        );
  const healthChecks = setInterval(() => recheckBackend(), backendTimeoutMs());
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
      ...upstreamFetchOptions(timeoutMs),
    });
  } catch (cause: unknown) {
    // Nobody waits for an answer to a request the browser abandoned.
    if (request.signal.aborted) throw cause;
    if (outage.aborted) return backendFailure(pathname, 503);
    void reportBackendFailure();
    return backendFailure(pathname, waiting.signal.aborted ? 504 : 503);
  } finally {
    clearTimeout(deadline);
    clearInterval(healthChecks);
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
