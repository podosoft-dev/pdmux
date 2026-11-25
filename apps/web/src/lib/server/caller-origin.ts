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
 *
 * ⚠ THE HEADER IS SET ON THIS REQUEST, NOT ON A COPY. Copying it with
 * `new Request(request, { headers })` made Bun tee the body stream, and behind
 * adapter-bun's own copy the branch nobody read stayed protected from garbage
 * collection with the whole body in it. Every proxied body leaked: a 1 GB file
 * transfer (1 MiB chunks) grew the web process past its 1 GiB limit and the
 * kernel killed it, taking every page and event stream down with it. Measured on
 * Bun 1.4.4 with the production image: 300 chunks left 301 MiB, 600 Request and
 * 600 tee states after a full GC with the copy, nothing without it.
 */
export function withCallerOrigin(request: Request): Request {
  const origin = new URL(request.url).origin;
  try {
    request.headers.set(CALLER_ORIGIN_HEADER, origin);
    return request;
  } catch {
    // A runtime that hands the server immutable headers gets the copy, which is
    // correct there; Bun and SvelteKit's own request objects are mutable.
    const headers = new Headers(request.headers);
    headers.set(CALLER_ORIGIN_HEADER, origin);
    return new Request(request, { headers });
  }
}
