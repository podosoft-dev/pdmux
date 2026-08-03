import type { RequestHandler } from "@sveltejs/kit";
import { backendBaseUrl, proxyRequest } from "$lib/server/backend-proxy";

// Proxy the better-auth handler, keeping the /api/auth prefix.
const handler: RequestHandler = ({ request, params, url, getClientAddress }) =>
  proxyRequest(request, `${backendBaseUrl()}/api/auth/${params.all}${url.search}`, getClientAddress());

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
