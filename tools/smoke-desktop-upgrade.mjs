import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { defaultLayout } from "@pdmux/core";
import { desktopPaths } from "./desktop-package-paths.mjs";

const [bundle, profile, directory, mode] = process.argv.slice(2);
assert.ok(profile.startsWith("/tmp/pdmux-") || profile.includes("/pdmux-"), "Require an isolated verification profile");
await mkdir(directory, { recursive: true });
const application = await electron.launch({ executablePath: desktopPaths(resolve(bundle), process.platform).executable, args: [`--user-data-dir=${resolve(profile)}`], chromiumSandbox: true, timeout: 120_000 });
try {
  const page = await application.firstWindow({ timeout: 120_000 });
  await page.waitForURL(/http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  if (mode === "old") {
    await page.locator('input#email').waitFor({ timeout: 60_000 });
    await page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Existing local profile", email: "desktop-upgrade@example.test", password: "Isolated-Upgrade-42!password" }) });
      if (!response.ok) throw new Error(`Cannot provision fixture (${response.status})`);
    });
    await page.goto(new URL("/", page.url()).href);
    await page.locator('[data-testid="shell-user"]').waitFor();
    const expected = await page.evaluate(async layout => {
      const hostResponse = await fetch("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Preserved local host" }) });
      if (!hostResponse.ok) throw new Error("Cannot create fixture host");
      const host = await hostResponse.json();
      const saved = { ...layout, slots: [{ id: "slot-1", hostId: host.id, kind: "attach", session: "preserved-session" }] };
      const response = await fetch("/api/prefs/layouts/default", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: saved, isDefault: true }) });
      if (!response.ok) throw new Error("Cannot save fixture layout");
      const user = await (await fetch("/api/account/me")).json();
      return { hostId: host.id, userId: user.id };
    }, defaultLayout());
    await writeFile(join(profile, "upgrade-expected.json"), JSON.stringify(expected));
    await page.reload();
  } else if (mode === "new") {
    await page.locator('[data-testid="shell-user"]').waitFor({ timeout: 60_000 });
    assert.ok(!new URL(page.url()).pathname.startsWith("/login"));
    const expected = JSON.parse(await readFile(join(profile, "upgrade-expected.json"), "utf8"));
    const actual = await page.evaluate(async () => ({ user: await (await fetch("/api/account/me")).json(), hosts: await (await fetch("/api/hosts")).json(), prefs: await (await fetch("/api/prefs")).json() }));
    assert.equal(actual.user.id, expected.userId);
    assert.ok(actual.hosts.some(host => host.id === expected.hostId));
    assert.ok(actual.prefs.layouts.some(row => row.payload.slots.some(slot => slot?.session === "preserved-session")));
    assert.equal(await application.evaluate(({ app }) => app.getName()), "PDMux");
    await page.locator('[data-testid="shell-user"]').click();
    await page.locator('[data-testid="shell-server-connection"]').click();
    await page.locator('[data-testid="desktop-connection"]').waitFor();
  }
  await page.waitForTimeout(500);
  const geometry = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    shell: (() => { const value = document.querySelector('[data-testid="dashboard-shell"] > :first-child')?.getBoundingClientRect(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null; })(),
    cards: [...document.querySelectorAll('[data-testid="desktop-connection"] [data-slot="card"]')].map(element => ({ height: element.clientHeight, content: element.scrollHeight })),
    body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
    panel: (() => { const value = document.querySelector('[data-testid="desktop-connection"]')?.getBoundingClientRect(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null; })(),
  }));
  assert.ok(geometry.body.width <= geometry.viewport.width);
  if (mode === "new") assert.equal(geometry.cards.length, 3);
  assert.ok(geometry.cards.every(card => card.content <= card.height + 1), "Cards must not clip their contents");
  await page.screenshot({ path: join(directory, `${mode}.png`) });
  if (mode === "new") { await page.locator('[data-testid="desktop-connection"]').evaluate(element => { element.scrollTop = element.scrollHeight; }); await page.screenshot({ path: join(directory, `${mode}-bottom.png`) }); }
  await writeFile(join(directory, `${mode}.json`), JSON.stringify(geometry, null, 2));
  console.log(JSON.stringify({ stage: "desktop-upgrade", mode, result: "passed", geometry }));
} finally { await application.close(); }
