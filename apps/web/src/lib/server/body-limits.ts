/**
 * Application-owned request body limits for /api requests that the web server
 * proxies to the API. An entry caps the body of every request whose path is
 * pathPrefix or below it, for example
 *   { pathPrefix: "/api/feedback/", maxBytes: 64 * 1024 }
 *   { pathPrefix: "/api/hosts/:hostId/uploads", maxBytes: 1024 * 1024 }
 * where a :name segment matches exactly one non-empty path segment. The most
 * specific entry wins: more segments, then a literal segment over a parameter
 * from the left. Above the limit the proxy stops reading and answers 413
 * PAYLOAD_TOO_LARGE without contacting the API.
 *
 * BODY_SIZE_LIMIT remains the ceiling for every web route: Bun rejects a larger
 * body before this code runs, so a maxBytes above it has no effect. Routes that
 * need more belong in the gateway's direct API paths (apiPaths in
 * .podokit/dev.json and the deployment profile), which bypass the web server.
 * PodoKit creates this file once and never overwrites it.
 */
export const APP_BODY_LIMITS: ReadonlyArray<{ pathPrefix: string; maxBytes: number }> = [];
