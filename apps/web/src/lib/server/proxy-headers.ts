/**
 * Application-owned header names that the managed /api proxy (backend-proxy.ts)
 * passes through in addition to its built-in lists. Names are case-insensitive.
 * Request headers listed here are forwarded from the browser to the API, such as
 * "x-api-key" for machine clients; response headers are relayed from the API to
 * the browser, such as "x-checksum-sha256". The proxy handles hop-by-hop headers,
 * host, content-length, content-encoding, set-cookie, and the forwarding headers
 * that carry the client address itself, so a listed one fails the build.
 * PodoKit creates this file once and never overwrites it.
 */
export const APP_FORWARDED_REQUEST_HEADERS: readonly string[] = [
  // ⚠ MCP's own headers. Without them a client's protocol negotiation is invisible
  // to the API, and the endpoint answers as if it were talking to something else.
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  // ⚠ A TRANSFER RESUMES ONLY IF THESE CROSS THE PROXY. The browser retries a
  // dropped download with `Range: bytes=N-` (the managed list carries `range` and
  // `if-range`) and addresses upload chunks by offset and digest; dropped here, the
  // API answers from byte zero and the transfer silently starts over — which is the
  // failure the offset-addressed file transfer exists to avoid.
  "content-range",
  "x-transfer-offset",
  "x-transfer-sha256",
];
export const APP_RELAYED_RESPONSE_HEADERS: readonly string[] = [
  "x-accel-buffering",
  "ratelimit-reset",
  // Same argument as the request side — plus `www-authenticate`, which is how an
  // MCP client learns it needs to present a key at all.
  "mcp-protocol-version",
  "mcp-session-id",
  "www-authenticate",
];
