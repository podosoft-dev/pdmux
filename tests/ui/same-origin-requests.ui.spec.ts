import { expect } from "@playwright/test";
import { test } from "../helpers/disposable-users";
import { ready } from "../helpers/hydration";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = new URL(base).origin;
// A 1 by 1 pixel PNG.
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// SvelteKit answers 403 "Cross-site ... form submissions are forbidden" to a POST,
// PUT, PATCH, or DELETE that has no content type or one an HTML form can send,
// unless its Origin header names the origin the web server resolved. The browser
// sends Origin with every same-origin request below, so FormData uploads and
// requests without a body reach the API through the /api proxy as they are. When
// a deployment returns that 403 anyway, the web server resolved another origin,
// such as http:// behind a TLS proxy whose X-Forwarded-Proto the ingress replaced.
test("same-origin uploads and requests without a body pass the origin check", async ({
  browser,
  playwright,
  disposableUsers,
}) => {
  const email = `same-origin-${Date.now()}@example.com`;
  const password = "Same-origin-password-1";
  await disposableUsers.create({ email, password, name: "Same origin" });
  // Start without the project's administrator cookies: with the multi-session
  // plugin, signing out ends every session the browser holds.
  const signIn = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin },
    storageState: { cookies: [], origins: [] },
  });
  expect((await signIn.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBeTruthy();
  const context = await browser.newContext({ storageState: await signIn.storageState() });
  await signIn.dispose();
  const page = await context.newPage();
  try {
    await ready(page, "/account");
    const origins: Record<string, string | undefined> = {};
    const recorded: Promise<void>[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (!pathname.startsWith("/api/")) return;
      recorded.push(request.allHeaders().then((headers) => {
        origins[`${request.method()} ${pathname}`] = headers.origin;
      }));
    });

    const results = await page.evaluate(async (png) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: "image/png" }), "pixel.png");
      const answer = async (response: Response): Promise<{ status: number; body: string }> => ({
        status: response.status,
        body: await response.text(),
      });
      return {
        upload: await answer(await fetch("/api/account/profile-image", { method: "POST", body: form })),
        remove: await answer(await fetch("/api/account/profile-image", { method: "DELETE" })),
        urlencoded: await answer(
          await fetch("/api/account/profile-image", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "file=pixel",
          }),
        ),
        signOut: await answer(await fetch("/api/auth/sign-out", { method: "POST" })),
      };
    }, PIXEL_PNG);

    // The multipart upload and the DELETE without a body reached the API and succeeded.
    expect(results.upload.status, results.upload.body).toBe(201);
    expect(JSON.parse(results.upload.body)).toMatchObject({ image: expect.stringContaining("/api/") });
    expect(results.remove.status, results.remove.body).toBe(200);
    // A form-encoded body is not an image, so the API, not SvelteKit, refuses it.
    expect(results.urlencoded.body).not.toContain("Cross-site");
    expect(JSON.parse(results.urlencoded.body)).toMatchObject({ success: false });
    // A POST without a body or content type signs the user out.
    expect(results.signOut.status, results.signOut.body).toBe(200);

    await Promise.all(recorded);
    expect(origins).toMatchObject({
      "POST /api/account/profile-image": origin,
      "DELETE /api/account/profile-image": origin,
      "POST /api/auth/sign-out": origin,
    });
  } finally {
    await context.close();
  }
});
