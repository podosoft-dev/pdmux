import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

// admin storageState (project default) — the admin is the resource owner.
const b64url = (b: Buffer): string => b.toString("base64url");
const REDIRECT = "http://localhost:9999/callback";

// Verifies the provider is correctly configured end to end on the front channel:
// signed discovery + JWKS, dynamic client registration, and an authorize request
// (with PKCE) that validates the client and hands off to the consent page. The
// back-channel token exchange is driven by an OIDC client SDK / real RP — see
// docs/modules.md for the manual round-trip checklist.
test("OIDC provider: discovery, JWKS, client registration, authorize handoff", async ({ page, baseURL }) => {
  const headers = { origin: baseURL ?? "" };
  await page.request.put("/api/account/settings", { data: { oidcProvider: true }, headers });
  await expect
    .poll(async () => (await page.request.get("/api/auth/.well-known/openid-configuration")).status(), { timeout: 8000 })
    .toBe(200);

  try {
    const disc = await (await page.request.get("/api/auth/.well-known/openid-configuration")).json();
    for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"]) {
      expect(typeof disc[field]).toBe("string");
    }
    // JWKS exposes at least one signing key (the OAuth provider needs it for id_tokens).
    const jwks = await (await page.request.get(disc.jwks_uri)).json();
    expect(Array.isArray(jwks.keys) && jwks.keys.length).toBeTruthy();

    // Dynamic client registration returns usable credentials. Retry: right after
    // the provider is enabled the auth instance may still be rebuilding.
    let reg: { client_id?: string; client_secret?: string } = {};
    await expect(async () => {
      reg = await (
        await page.request.post("/api/auth/oauth2/create-client", {
          data: { client_name: "E2E RP", redirect_uris: [REDIRECT] },
          headers,
        })
      ).json();
      expect(reg.client_id).toBeTruthy();
    }).toPass({ timeout: 8000 });
    expect(reg.client_secret).toBeTruthy();

    // Authorize validates the client + PKCE and hands off to the consent page with
    // the signed authorization request.
    const verifier = b64url(randomBytes(40));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const authorizeUrl =
      `/api/auth/oauth2/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&response_type=code&scope=${encodeURIComponent("openid profile email")}&state=st` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const authz = await (await page.request.get(authorizeUrl, { headers })).json();
    expect(String(authz.url)).toContain("/oauth2/consent");
    expect(String(authz.url)).toContain("client_id=");

    // The consent page renders (reached in a real browser navigation).
    await page.goto(authz.url);
    await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  } finally {
    await page.request.put("/api/account/settings", { data: { oidcProvider: false }, headers });
  }
});
