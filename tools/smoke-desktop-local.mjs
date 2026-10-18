import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StackManager } from "../apps/desktop/src/stack-manager.ts";

const root = await mkdtemp(join(tmpdir(), "pdmux-local-profile-"));
const repository = resolve(import.meta.dirname, "..");
const layout = {
  bunExecutable: process.execPath,
  apiEntry: join(repository, "apps/api/dist/main.js"), migrateEntry: join(repository, "apps/api/dist/desktop-migrate.js"),
  webEntry: join(repository, "apps/web/build/index.js"), dataDirectory: root, filesDirectory: join(root, "files"),
  databasePath: join(root, "pdmux.sqlite"), secretPath: join(root, "auth.secret"), agentReleaseDirectory: join(repository, "apps/web/build/client/agent"),
};
const stack = new StackManager(layout);
try {
  const { apiUrl, webUrl } = await stack.start();
  const refused = await fetch(`${apiUrl}/api/auth/desktop-local/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(refused.status, 404);
  assert.deepEqual(await stack.profiles(), []);
  const response = await stack.localSession();
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie);
  const profile = await response.json();
  await stack.control("attach");
  const me = await fetch(`${apiUrl}/account/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).id, profile.profileId);
  const view = await fetch(webUrl, { headers: { cookie }, redirect: "manual" });
  assert.equal(view.status, 200);
  assert.ok((await view.text()).includes("PDMux"));
  const host = await fetch(`${apiUrl}/hosts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "local-profile-smoke" }) });
  assert.equal(host.status, 201);
  const created = await host.json();
  const prefs = await fetch(`${apiUrl}/prefs/layouts/default`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ payload: { mode: "single", slots: [] }, isDefault: true }) });
  assert.equal(prefs.status, 200);
  await stack.restart();
  const second = await stack.localSession(profile.profileId);
  const restoredCookie = second.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  await stack.control("attach");
  const again = await fetch(`${(await stack.start()).apiUrl}/hosts`, { headers: { cookie: restoredCookie } });
  assert.equal(again.status, 200);
  assert.ok((await again.json()).some(item => item.id === created.id));
  console.log(JSON.stringify({ stage: "desktop-local-profile", result: "passed", preserved: true }));
} finally { await stack.stop(); await rm(root, { recursive: true, force: true }); }
