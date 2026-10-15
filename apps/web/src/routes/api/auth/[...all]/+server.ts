import type { RequestHandler } from "@sveltejs/kit";
import { backendBaseUrl, proxyRequest, rawSubpath, resolveClientIp } from "#lib/server/backend-proxy.js";

// Proxy the better-auth handler, keeping the /api/auth prefix.
const handler: RequestHandler = ({ request, url, getClientAddress }) =>
  proxyRequest(
    request,
    `${backendBaseUrl()}/api/auth/${rawSubpath(url, "/api/auth/")}${url.search}`,
    resolveClientIp(getClientAddress),
  );

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
