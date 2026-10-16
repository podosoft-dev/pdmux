/**
 * The header that tells the API which origin the caller reached.
 *
 * ⚠ Without it the API sees only its own container name, and anything it builds
 * an absolute URL from (the MCP endpoint's install command is the case that
 * caught this) hands out an address that resolves nowhere outside the network.
 * The managed proxy reserves X-Forwarded-Host and X-Forwarded-Proto, so the
 * origin travels in this header, listed in proxy-headers.ts.
 */
export const CALLER_ORIGIN_HEADER = "x-pdmux-caller-origin";

/**
 * The request with CALLER_ORIGIN_HEADER set to the origin of its URL, which
 * adapter-bun has already resolved through ORIGIN or PROTOCOL_HEADER and
 * HOST_HEADER. A value the caller sent is replaced, never forwarded.
 */
export function withCallerOrigin(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(CALLER_ORIGIN_HEADER, new URL(request.url).origin);
  // The copy keeps the method, the body stream, and the request's abort signal.
  return new Request(request, { headers });
}
