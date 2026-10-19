import { expect } from "@playwright/test";
import { test } from "../helpers/disposable-users";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = new URL(base).origin;
const signedOut = { cookies: [], origins: [] };
// A 1 by 1 pixel PNG.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// Scripts and other clients that are not browsers send no Origin header. Their
// uploads and requests without a body reach the API through the /api proxy, and
// the API's own authentication decides the answer.
test("clients without an Origin header use a session through /api", async ({ playwright, disposableUsers }) => {
  const email = `no-origin-${Date.now()}@example.com`;
  const password = "No-origin-password-1";
  await disposableUsers.create({ email, password, name: "No origin" });
  const signIn = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin },
    storageState: signedOut,
  });
  expect((await signIn.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBeTruthy();
  const client = await playwright.request.newContext({ baseURL: base, storageState: await signIn.storageState() });
  await signIn.dispose();
  const anonymous = await playwright.request.newContext({ baseURL: base, storageState: signedOut });
  try {
    const upload = await client.post("/api/account/profile-image", {
      multipart: { file: { name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG } },
    });
    expect(upload.status(), await upload.text()).toBe(201);
    const removed = await client.delete("/api/account/profile-image");
    expect(removed.status(), await removed.text()).toBe(200);
    expect(await removed.json()).toEqual({ image: null });

    const refused = await anonymous.delete("/api/account/profile-image");
    expect(refused.status(), await refused.text()).toBe(401);
  } finally {
    await client.dispose();
    await anonymous.dispose();
  }
});
