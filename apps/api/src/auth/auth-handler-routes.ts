import { Elysia } from "elysia";

/**
 * The paths Better Auth answers: its base path and the OAuth discovery
 * documents RFC 8414 and RFC 9728 place at the origin root. Mounting the
 * handler at "/" instead made it answer every unmatched request with an empty
 * 404, bypassing the application's not-found error envelope.
 */
export const AUTH_HANDLER_PATHS = [
  "/api/auth",
  "/api/auth/*",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/*",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/*",
] as const;

/** Routes each Better Auth path to its handler without parsing the body. */
export function authHandlerRoutes(handler: (request: Request) => Promise<Response>): Elysia {
  const routes = new Elysia({ name: "podokit.auth.handler" });
  for (const path of AUTH_HANDLER_PATHS) {
    routes.all(path, ({ request }) => handler(request), { parse: "none", detail: { hide: true } });
  }
  return routes;
}
