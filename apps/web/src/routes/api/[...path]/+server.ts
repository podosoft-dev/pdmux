import type { RequestHandler } from "@sveltejs/kit";
import { backendBaseUrl, proxyRequest } from "$lib/server/backend-proxy";

// Proxy the app's REST API, stripping the /api prefix (backend routes are at root).
const handler: RequestHandler = ({ request, params, url, getClientAddress }) =>
  proxyRequest(request, `${backendBaseUrl()}/${params.path}${url.search}`, getClientAddress());

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
