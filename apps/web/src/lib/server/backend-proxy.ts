// Server-side proxy boundary. The browser never talks to the API directly:
// requests go through SvelteKit server routes, which forward an allowlist of
// headers to BACKEND_INTERNAL_URL and relay the response (including Set-Cookie).
//
// `user-agent` is on the list for the same reason the client IP is forwarded
// below: better-auth records it on the session and the account page shows it as
// the device. Leaving it off does not produce an empty column -- fetch supplies
// its own default, so every session in the database reads "node", and the list
// of "your devices" becomes a list of identical rows that identify nothing.
const FORWARDED_HEADERS = [
  "authorization",
  // ⚠ MCP's own headers. Without them a client's protocol negotiation is invisible
  // to the API, and the endpoint answers as if it were talking to something else.
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "cookie",
  "content-type",
  "accept",
  "origin",
  "referer",
  "user-agent",
];
const RELAYED_RESPONSE_HEADERS = [
  "content-type",
  "location",
  "cache-control",
  // Same argument in the other direction — plus `www-authenticate`, which is how
  // an MCP client learns it needs to present a key at all.
  "mcp-protocol-version",
  "mcp-session-id",
  "www-authenticate",
];

// The API's address and the client-IP spelling are shared with `server.js`, which
// proxies the terminal upgrade outside the bundle and cannot import TypeScript.
// Re-exported here so this module stays the one import site for the proxy boundary.
export { backendBaseUrl, normalizeClientIp } from "./backend-target.js";
import { normalizeClientIp } from "./backend-target.js";

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
  for (const name of FORWARDED_HEADERS) {
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

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    // Preserve multipart uploads and other binary bodies byte-for-byte. Reading
    // them as text corrupts bytes that are not valid UTF-8 before forwarding.
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });

  const responseHeaders = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Relay Set-Cookie so auth session cookies reach the browser.
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
