import type { RequestHandler } from "@sveltejs/kit";
import { backendBaseUrl, proxyRequest, rawSubpath, resolveClientIp } from "#lib/server/backend-proxy.js";
import { withCallerOrigin } from "#lib/server/caller-origin.js";

// Proxy the app's REST API, stripping the /api prefix (backend routes are at root).
const handler: RequestHandler = ({ request, url, getClientAddress, platform }) =>
  proxyRequest(
    withCallerOrigin(request),
    `${backendBaseUrl()}/${rawSubpath(url, "/api/")}${url.search}`,
    resolveClientIp(getClientAddress),
    platform?.server,
  );

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
