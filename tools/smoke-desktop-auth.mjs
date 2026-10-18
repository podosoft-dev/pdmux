import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { desktopPaths } from "./desktop-package-paths.mjs";
import { resolve } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, cookie, profile, bundle, workspaceId } = JSON.parse(input);
const application = await electron.launch({ ...(bundle === "source" ? {} : { executablePath: desktopPaths(resolve(bundle), process.platform).executable }), args: [...(bundle === "source" ? [resolve(import.meta.dirname, "../apps/desktop")] : []), `--user-data-dir=${profile}`], chromiumSandbox: true, timeout: 120_000 });
try {
  await application.evaluate(({ shell }) => { shell.openExternal = async value => { globalThis.__pdmuxAuthUrl = value; }; });
  const page = await application.firstWindow({ timeout: 120_000 });
  await page.locator('[data-testid="shell-user"]').waitFor({ timeout: 60_000 });
  await page.evaluate(async value => window.pdmuxDesktop.connection.connect(value), url);
  const browserUrl = await application.evaluate(() => globalThis.__pdmuxAuthUrl);
  assert.equal(new URL(browserUrl).origin, url);
  const query = new URL(browserUrl).search;
  assert.ok(new URLSearchParams(query).get("code_challenge"), "Require a PKCE challenge");
  const transfer = await fetch(`${url}/api/auth/electron/transfer-user${query}`, { method: "POST", headers: { cookie, origin: url, "content-type": "application/json" }, body: "{}" });
  assert.equal(transfer.status, 200);
  const authorization = await transfer.json();
  assert.ok(authorization.electron_authorization_code);
  const callbackCookie = transfer.headers.getSetCookie().find(value => value.startsWith("better-auth.pdmux-desktop="));
  assert.ok(callbackCookie);
  const callbackCode = callbackCookie.split(";")[0].slice("better-auth.pdmux-desktop=".length);
  await page.evaluate(async code => window.pdmuxDesktop.connection.authenticate(code), callbackCode);
  const status = await page.evaluate(async () => (await fetch("/api/desktop/status")).json());
  assert.equal(status.connected, true);
  if (workspaceId) {
    await page.evaluate(async id => window.pdmuxDesktop.connection.workspace(id), workspaceId);
    assert.equal((await page.evaluate(async () => (await fetch("/api/desktop/status")).json())).scopeId, workspaceId);
  }
  const replay = await fetch(`${url}/api/auth/electron/token`, { method: "POST", headers: { "content-type": "application/json", origin: "dev.podosoft.pdmux:/" }, body: JSON.stringify({ token: authorization.electron_authorization_code, code_verifier: "invalid" }) });
  assert.ok(replay.status >= 400, "Authorization codes cannot be replayed");
  await page.evaluate(async () => window.pdmuxDesktop.connection.disconnect());
  assert.equal((await page.evaluate(async () => (await fetch("/api/desktop/status")).json())).connected, false);
  console.log(JSON.stringify({ stage: "desktop-native-pkce", result: "passed", replayRejected: true }));
} finally { await application.close(); }
