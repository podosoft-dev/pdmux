import type { RequestEvent } from "@sveltejs/kit";
import { createApiClient, type ApiClient } from "@podosoft/podokit-api-client";
import { backendBaseUrl, resolveClientIp } from "./backend-proxy";

// Server-side client for load functions and hooks: points at the internal
// backend URL and forwards the incoming request's cookies.
export function serverApiClient(event: RequestEvent): ApiClient {
  const cookie = event.request.headers.get("cookie") ?? "";
  const clientIp = resolveClientIp(event.getClientAddress);
  const fetchWithCookies: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", cookie);
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    return event.fetch(input, { ...init, headers });
  };
  return createApiClient({
    baseUrl: backendBaseUrl(),
    apiBasePath: "",
    fetch: fetchWithCookies,
  });
}
