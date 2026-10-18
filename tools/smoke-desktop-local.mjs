import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalAgent } from "../apps/desktop/src/local-agent.ts";
import { StackManager } from "../apps/desktop/src/stack-manager.ts";

const root = await mkdtemp(join(tmpdir(), "pdmux-local-profile-"));
const repository = resolve(import.meta.dirname, "..");
const layout = {
  bunExecutable: process.execPath,
  apiEntry: join(repository, "apps/api/dist-desktop/main.js"), migrateEntry: join(repository, "apps/api/dist-desktop/desktop-migrate.js"),
  webEntry: join(repository, "apps/web/build-desktop/index.js"), dataDirectory: root, filesDirectory: join(root, "files"),
  databasePath: join(root, "pdmux.sqlite"), secretPath: join(root, "auth.secret"), agentReleaseDirectory: join(repository, "apps/web/build-desktop/client/agent"),
};
const stack = new StackManager(layout);
let agent;
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
  for (const path of ["/admin/users", "/api/auth/sign-up/email", "/api/auth/admin/list-users", "/api/auth/organization/list", "/account/settings"]) {
    const removed = await fetch(`${apiUrl}${path}`, { headers: { cookie } });
    assert.equal(removed.status, 404, `[TC-PDDESKTOP-015] desktop excludes ${path}`);
  }
  const tmuxDirectory = join(root, "tmux"); await mkdir(tmuxDirectory);
  agent = new LocalAgent(stack, layout, profile.profileId, "Local smoke", { environment: { ...process.env, TMUX_TMPDIR: tmuxDirectory } });
  await agent.start();
  assert.equal(agent.status().phase, "ready", "[TC-PDDESKTOP-017] native agent connects on first launch");
  const localHost = agent.status().hostId;
  const initialPrefs = await (await stack.localRequest("/prefs")).json();
  assert.equal(initialPrefs.layouts.find(row => row.isDefault).payload.slots[0].hostId, localHost);
  assert.equal(initialPrefs.layouts.find(row => row.isDefault).payload.slots[0].kind, "shell");
  const me = await fetch(`${apiUrl}/account/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).id, profile.profileId);
  const view = await fetch(webUrl, { headers: { cookie }, redirect: "manual" });
  assert.equal(view.status, 200);
  assert.ok((await view.text()).includes("PDMux"));
  const fleet = await fetch(`${apiUrl}/fleet/settings`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ mcpUserTokens: true }) });
  assert.equal(fleet.status, 200);
  const tokenResponse = await fetch(`${apiUrl}/account/mcp-tokens`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "Local smoke", tier: "admin", expiresInDays: 7 }) });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();
  const mcp = new Client({ name: "pdmux-local-smoke", version: "1" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL("/mcp", webUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    assert.ok((await mcp.listTools()).tools.some(tool => tool.name === "hosts_list"));
  } finally { await mcp.close(); }
  const host = await fetch(`${apiUrl}/hosts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "local-profile-smoke" }) });
  assert.equal(host.status, 201);
  const created = await host.json();
  const prefs = await fetch(`${apiUrl}/prefs/layouts/default`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ payload: { mode: "single", slots: [] }, isDefault: true }) });
  assert.equal(prefs.status, 200);
  await agent.stop();
  await stack.restart();
  const second = await stack.localSession(profile.profileId);
  const restoredCookie = second.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  await stack.control("attach");
  await agent.start();
  assert.equal(agent.status().hostId, localHost);
  assert.equal(agent.status().phase, "ready");
  const preservedPrefs = await (await stack.localRequest("/prefs")).json();
  assert.deepEqual(preservedPrefs.layouts.find(row => row.isDefault).payload.slots, []);
  const again = await fetch(`${(await stack.start()).apiUrl}/hosts`, { headers: { cookie: restoredCookie } });
  assert.equal(again.status, 200);
  assert.ok((await again.json()).some(item => item.id === created.id));
  console.log(JSON.stringify({ stage: "desktop-local-profile", result: "passed", preserved: true }));
} finally { await agent?.stop(); await stack.stop(); await rm(root, { recursive: true, force: true }); }
