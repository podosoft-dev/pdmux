import { expect, test } from "@playwright/test";

// api-key auth is machine-to-machine: clients call the backend API directly, not
// through the browser web proxy (which strips custom headers by design). So this
// test targets the backend URL (`E2E_API_URL`) and skips when it isn't provided.
const apiBase = process.env.E2E_API_URL;
const apiOrigin = { origin: apiBase ?? "" };

// The static service key(s) come from the `API_KEYS` env var; the module ships
// `dev-key-please-change` as the default in .env.example.
const KEY = process.env.E2E_API_KEY ?? "dev-key-please-change";

test("api-key auth: a valid key passes, missing/invalid are 401 @smoke", async ({ request }) => {
  test.skip(!apiBase, "E2E_API_URL (backend base) not set");
  const ok = await request.get(`${apiBase}/machine/ping`, { headers: { ...apiOrigin, "x-api-key": KEY } });
  test.skip(ok.status() === 404, "api-key-auth not installed");
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, via: "api-key" });

  const missing = await request.get(`${apiBase}/machine/ping`, { headers: apiOrigin });
  expect(missing.status()).toBe(401);

  const invalid = await request.get(`${apiBase}/machine/ping`, { headers: { ...apiOrigin, "x-api-key": "wrong-key" } });
  expect(invalid.status()).toBe(401);
});
