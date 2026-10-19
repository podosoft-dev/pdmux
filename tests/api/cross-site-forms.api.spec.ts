import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

const origin = new URL(process.env.E2E_BASE_URL ?? "http://localhost:5001").origin;
const FOREIGN = "https://cross-site.example";

// The web server refuses a cross-site form submission: a POST, PUT, PATCH, or
// DELETE with no content type or one an HTML form can send, from another site.
// Clients that are not browsers send no Origin header; on /api they reach the
// API, which authenticates them, while pages refuse them as SvelteKit does. The
// API has no write routes under /health, so its 404 shows a request got through.

async function viteDevServer(request: APIRequestContext): Promise<boolean> {
  const client = await request.get("/@vite/client", { maxRedirects: 0 });
  return client.status() === 200 && (client.headers()["content-type"] ?? "").includes("javascript");
}

async function expectApiAnswer(response: APIResponse, what: string): Promise<void> {
  expect(await response.text(), what).not.toContain("Cross-site");
  expect(response.status(), what).toBe(404);
}

test("API clients without an Origin header reach the API through /api", async ({ request }) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await expectApiAnswer(await request.fetch("/api/health", { method }), `${method} without a body`);
  }
  await expectApiAnswer(await request.post("/api/health", { form: { note: "ping" } }), "form-encoded");
  await expectApiAnswer(await request.post("/api/health", { multipart: { note: "ping" } }), "multipart");
  await expectApiAnswer(
    await request.post("/api/health", { headers: { "content-type": "text/plain" }, data: "ping" }),
    "text/plain",
  );
  await expectApiAnswer(await request.post("/api/health", { data: { note: "ping" } }), "JSON");
});

test("cross-site form submissions are refused on pages and /api", async ({ request }) => {
  test.skip(await viteDevServer(request), "Like SvelteKit's, the check does not run on the Vite dev server");
  for (const path of ["/", "/api/health"]) {
    const response = await request.post(path, { headers: { origin: FOREIGN }, form: { note: "ping" } });
    expect(response.status(), path).toBe(403);
    expect(await response.text(), path).toBe("Cross-site POST form submissions are forbidden");
  }
  const asJson = await request.delete("/api/health", { headers: { origin: FOREIGN, accept: "application/json" } });
  expect(asJson.status()).toBe(403);
  expect(await asJson.json()).toEqual({ message: "Cross-site DELETE form submissions are forbidden" });
  // Pages, unlike /api, also refuse a form submission without an Origin header.
  const withoutOrigin = await request.post("/", { form: { note: "ping" } });
  expect(withoutOrigin.status()).toBe(403);
});

test("same-origin form submissions pass the check", async ({ request }) => {
  const response = await request.post("/", { headers: { origin }, form: { note: "ping" } });
  expect(await response.text()).not.toContain("Cross-site");
  expect(response.status()).not.toBe(403);
});
