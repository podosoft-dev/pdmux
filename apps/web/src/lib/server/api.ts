import type { RequestEvent } from "@sveltejs/kit";
import { createApiClient, type ApiClient } from "@podosoft/podokit-api-client";
import {
  backendBaseUrl,
  backendOutageSignal,
  backendReachable,
  backendTimeoutMs,
  reportBackendAnswer,
  reportBackendFailure,
  resolveClientIp,
  setForwardedOrigin,
} from "./backend-proxy";

/** Thrown without contacting the API while it is known to be unreachable. */
export class BackendUnavailableError extends Error {
  constructor() {
    super("The API is unavailable");
    this.name = "BackendUnavailableError";
  }
}

// Server-side client for load functions and hooks: points at the internal
// backend URL and forwards the incoming request's cookies, client address, and
// public origin as the /api proxy does. Each call is bounded
// by BACKEND_TIMEOUT_MS, so a page renders its fallbacks instead of waiting for
// an API that does not answer.
export function serverApiClient(event: RequestEvent): ApiClient {
  const cookie = event.request.headers.get("cookie") ?? "";
  const clientIp = resolveClientIp(event.getClientAddress);
  const fetchWithCookies: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      if (!backendReachable()) throw new BackendUnavailableError();
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("cookie", cookie);
      if (clientIp) headers.set("x-forwarded-for", clientIp);
      setForwardedOrigin(headers, event.url);
      const outage = backendOutageSignal();
      const signals = [AbortSignal.timeout(backendTimeoutMs()), outage];
      if (init?.signal) signals.push(init.signal);
      try {
        const response = await event.fetch(input, { ...init, headers, signal: AbortSignal.any(signals) });
        reportBackendAnswer();
        return response;
      } catch (cause: unknown) {
        if (outage.aborted) throw new BackendUnavailableError();
        if (!init?.signal?.aborted) void reportBackendFailure();
        throw cause;
      }
    },
    { preconnect: fetch.preconnect },
  );
  return createApiClient({
    baseUrl: backendBaseUrl(),
    apiBasePath: "",
    fetch: fetchWithCookies,
  });
}
