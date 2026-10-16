import type { RequestHandler } from "@sveltejs/kit";

// Liveness and readiness of the web server itself, for the Kubernetes probes,
// the Compose healthcheck, and the image HEALTHCHECK. It never calls the API, so
// an API outage does not take the web server out of service.
export const GET: RequestHandler = () =>
  new Response("ok\n", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
