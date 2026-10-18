import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ params, request }) => {
  if (!/^\d+\.\d+\.\d+$/.test(params.version) || !/^pdmux-agent-(linux|darwin)-(amd64|arm64)$/.test(params.file)) return new Response(null, { status: 404 });
  const backend = process.env.BACKEND_INTERNAL_URL;
  if (!backend) return new Response(null, { status: 404 });
  const response = await fetch(`${backend}/desktop/agents/${params.version}/${params.file}`, { signal: request.signal, redirect: "error" });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
};
