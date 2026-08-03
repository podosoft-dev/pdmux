import type { RequestHandler } from "@sveltejs/kit";

import { backendBaseUrl, proxyRequest } from "$lib/server/backend-proxy";

/**
 * The public MCP endpoint, proxied straight through to the API.
 *
 * It sits at the origin's root rather than under `/api` because it is the URL a
 * person pastes into a CLI's config — `https://<origin>/mcp` is the shape every
 * MCP client's documentation uses, and an extra path segment is one more thing to
 * get wrong by hand.
 *
 * GET and DELETE are forwarded rather than refused here: the API answers 405 with
 * a JSON-RPC body, which an MCP client can read. Refusing at the proxy would give
 * it an HTML error page instead.
 */
const handler: RequestHandler = ({ request, getClientAddress }) =>
  proxyRequest(request, `${backendBaseUrl()}/mcp`, getClientAddress());

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
