import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { gzipSync } from "node:zlib";
import type { SyncChange, SyncRecord } from "@pdmux/desktop-protocol";
import type { Repository } from "typeorm";
import { DesktopClient, type DesktopClientOptions } from "./desktop-client";
import { recordHash, type DesktopService } from "./desktop.service";
import { KeyedMutex } from "./keyed-mutex";
import type { DesktopConnection } from "./desktop-connection.entity";
const session = (id: string) => ({ user: { id }, session: {} });
afterEach(() => mock.restore());

it("[TC-PDDESKTOP-013][TC-PDTERM-144] relays a compressed inline image without decoding it twice", async () => {
  const realFetch = globalThis.fetch;
  const payload = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADAQMAAACDJEzCAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWYzmf///129H+IAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcVCSUTzXBDTwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yMVQwOTozNzoxOSswMDowMOuehLIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjFUMDk6Mzc6MTkrMDA6MDCawzwOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTIxVDA5OjM3OjE5KzAwOjAwzdYd0QAAAAtJREFUCNdjYAABAAAGAAFm9MlsAAAAAElFTkSuQmCC", "base64");
  const compressed = gzipSync(payload);
  const hostId = "00000000-0000-4000-8000-000000000001";
  const hostKey = "server:host:image";
  let path = "";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    path = new URL(request.url).pathname + new URL(request.url).search;
    return new Response(compressed, { headers: {
      "content-type": "image/png", "content-encoding": "gzip", "content-length": String(compressed.length),
      "content-disposition": "inline; filename=preview.png", "x-content-type-options": "nosniff",
    } });
  } });
  const { client } = fixture({ syncIntervalMs: 60_000, createSocket: () => new BridgeSocket() as unknown as WebSocket });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/desktop/context") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", organizations: [] });
    if (url.pathname === "/api/auth/get-session") return Response.json({ user: { id: "remote", name: "Remote user", email: "remote@example.test" } });
    if (url.pathname === "/api/desktop/sync") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", hostIds: { [hostKey]: hostId }, conflicts: [], records: [] });
    return realFetch(new URL(url.pathname + url.search, upstream.url), init);
  }, { preconnect: (): void => {} }));
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => client.cloudRequest({
    hostKey, method: "GET", path: `/hosts/${hostId}/files/download?path=preview.png&inline=1`, headers: {},
  }, null, request.signal) });
  try {
    await client.attach(session("image-preview"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    // Real HTTP on both sides: fetch transparently decodes gzip, unlike a mocked Response.
    const response = await realFetch(relay.url, { signal: AbortSignal.timeout(3_000) });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(payload));
    expect(path).toBe(`/api/hosts/${hostId}/files/download?path=preview.png&inline=1`);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline; filename=preview.png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-encoding")).toBeNull();
  } finally { client.disconnect(); await relay.stop(true); await upstream.stop(true); }
});
function fixture(options?: DesktopClientOptions): { client: DesktopClient; service: DesktopService } {
  const service = { origin: "server", connectionKey: "", lock: new KeyedMutex(), syncKeys: () => ["hosts:test", "prefs:test"], snapshot: async () => [] } as unknown as DesktopService;
  const store = {
    findOneBy: async ({ userId }: { userId: string }) => userId === "old" ? { userId, state: { deviceId: crypto.randomUUID(), selected: "old-account", accounts: { "old-account": { url: "https://previous.example.test", userId: "remote", scopeId: "personal:remote", bases: {}, hostIds: {}, conflicts: [] } } } } : null,
    save: async (value: unknown) => value,
  } as unknown as Repository<DesktopConnection>;
  return { client: new DesktopClient(service, store, options), service };
}

class BridgeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  send(): void {}
  close(): void { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  accept(): void { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
}

function hostDeletionFixture(): {
  client: DesktopClient; service: DesktopService; key: string; hostId: string; removed: () => boolean;
  rejectSync: (status: number) => void; conflict: () => void; changes: () => SyncChange[]; directDeletes: () => number;
} {
  const { client, service } = fixture({ syncIntervalMs: 60_000, createSocket: () => new BridgeSocket() as unknown as WebSocket });
  const hostId = "00000000-0000-4000-8000-000000000001", key = `host:other-desktop:${hostId}`;
  const record: SyncRecord = { key, kind: "host", origin: "other-desktop", value: { label: "Offline desktop" } };
  let local = record, remote = record, status = 200, conflicting = false, deletes = 0;
  let sent: SyncChange[] = [];
  service.snapshot = async () => [local];
  service.apply = async (_session, value) => { local = value; };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/api/desktop/context") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", organizations: [] });
    if (path === "/api/auth/get-session") return Response.json({ user: { id: "remote", name: "Remote user", email: "remote@example.test" } });
    if (path === "/api/desktop/sync") {
      sent = (JSON.parse(String(init?.body)) as { changes: SyncChange[] }).changes;
      if (status !== 200) return new Response(null, { status });
      const change = sent.find(value => value.key === key)!;
      if (!conflicting) remote = change;
      return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", hostIds: remote.value ? { [key]: hostId } : {},
        records: [{ ...remote, hash: recordHash(remote.value) }], conflicts: conflicting ? [{ key, local: change, server: remote, serverHash: recordHash(remote.value) }] : [] });
    }
    if (init?.method === "DELETE") { deletes += 1; return Response.json({ error: { code: "DESKTOP_OFFLINE" } }, { status: 503 }); }
    throw new Error(`Unexpected host deletion request ${path}`);
  }, { preconnect: (): void => {} }));
  return { client, service, key, hostId, removed: () => local.value === null, rejectSync: value => { status = value; }, conflict: () => { conflicting = true; }, changes: () => sent, directDeletes: () => deletes };
}

it("[TC-PDDESKTOP-012][TC-PDDESKTOP-013] deletes an offline desktop host through its synchronized metadata", async () => {
  const f = hostDeletionFixture();
  try {
    await f.client.attach(session("local"), "local-cookie");
    await f.client.connect("https://server.example.test", "cloud-cookie");
    const response = await f.client.cloudRequest({ hostKey: f.key, method: "DELETE", path: `/hosts/${f.hostId}`, headers: {} }, null, new AbortController().signal);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: f.hostId, label: "Offline desktop" });
    expect(f.directDeletes()).toBe(0);
    expect(f.changes()).toMatchObject([{ key: f.key, kind: "host", value: null, base: recordHash({ label: "Offline desktop" }) }]);
    expect(f.removed()).toBe(true);
    await f.client.sync();
    expect(f.changes()[0]?.value).toBeNull();
  } finally { f.client.disconnect(); }
});

it.each([403, 503])("[TC-PDDESKTOP-012] preserves a host when its server refuses deletion (%s)", async status => {
  const f = hostDeletionFixture();
  try {
    await f.client.attach(session("local"), "local-cookie");
    await f.client.connect("https://server.example.test", "cloud-cookie");
    f.rejectSync(status);
    await expect(f.client.cloudRequest({ hostKey: f.key, method: "DELETE", path: `/hosts/${f.hostId}`, headers: {} }, null, new AbortController().signal)).rejects.toMatchObject({ statusCode: status });
    expect(f.removed()).toBe(false);
    f.rejectSync(200);
    await f.client.sync();
    expect(f.changes()[0]?.value).toEqual({ label: "Offline desktop" });
  } finally { f.client.disconnect(); }
});

it("[TC-PDDESKTOP-012] reports a deletion conflict instead of silently removing a changed host", async () => {
  const f = hostDeletionFixture();
  try {
    await f.client.attach(session("local"), "local-cookie");
    await f.client.connect("https://server.example.test", "cloud-cookie");
    f.conflict();
    await expect(f.client.cloudRequest({ hostKey: f.key, method: "DELETE", path: `/hosts/${f.hostId}`, headers: {} }, null, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.removed()).toBe(false);
    expect(f.client.status()).toMatchObject({ conflicts: [{ key: f.key }] });
  } finally { f.client.disconnect(); }
});

it.each([false, true])("[TC-PDDESKTOP-012] waits for a running sync before deletion and checks cancellation (disconnect=%s)", async disconnect => {
  const f = hostDeletionFixture();
  let unlock: (() => void) | undefined;
  try {
    await f.client.attach(session("local"), "local-cookie");
    await f.client.connect("https://server.example.test", "cloud-cookie");
    unlock = await f.service.lock.acquire(f.service.syncKeys(session("local")));
    const syncing = f.client.sync();
    await new Promise(resolve => setImmediate(resolve));
    let done = false;
    const removal = f.client.cloudRequest({ hostKey: f.key, method: "DELETE", path: `/hosts/${f.hostId}`, headers: {} }, null, new AbortController().signal);
    void removal.then(() => { done = true; }, () => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(done).toBe(false);
    if (disconnect) f.client.disconnect();
    unlock(); unlock = undefined;
    await syncing;
    if (disconnect) await expect(removal).rejects.toMatchObject({ code: "DESKTOP_CONNECTION_CANCELLED" });
    else expect((await removal).status).toBe(200);
    expect(f.removed()).toBe(!disconnect);
  } finally { unlock?.(); f.client.disconnect(); }
});

function reconnectFixture(acceptBridge = true): { client: DesktopClient; sockets: BridgeSocket[]; contextStatus: (status: number) => void; syncs: () => number } {
  const sockets: BridgeSocket[] = [];
  const { client } = fixture({
    syncIntervalMs: 10,
    bridgeTimeoutMs: 50,
    createSocket: () => { const socket = new BridgeSocket(); sockets.push(socket); if (acceptBridge) queueMicrotask(() => socket.accept()); return socket as unknown as WebSocket; },
  });
  let status = 200;
  let syncs = 0;
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/api/desktop/context") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", organizations: [] }, { status });
    if (path === "/api/auth/get-session") return Response.json({ user: { id: "remote", name: "Remote user", email: "remote@example.test", role: "user" } });
    if (path === "/api/desktop/sync") { syncs += 1; return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", hostIds: {}, conflicts: [], records: [] }); }
    throw new Error(`Unexpected test request ${path}`);
  }, { preconnect: (): void => {} }));
  return { client, sockets, contextStatus: value => { status = value; }, syncs: () => syncs };
}

it("[TC-PDDESKTOP-012] keeps credentials during server 503s and resumes synchronization without another login", async () => {
  const { client, sockets, contextStatus, syncs } = reconnectFixture();
  try {
    await client.attach(session("new"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    contextStatus(503);
    sockets[0]?.close();
    await expect(client.sync()).rejects.toMatchObject({ code: "DESKTOP_SERVER_UNAVAILABLE" });
    expect(client.status()).toMatchObject({ connected: true });
    contextStatus(200);
    const before = syncs();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(syncs()).toBeGreaterThan(before);
    expect(sockets.length).toBeGreaterThan(1);
    expect(client.status()).toMatchObject({ connected: true, bridgeConnected: true, error: null });
  } finally { client.disconnect(); }
});

it("[TC-PDDESKTOP-012] keeps the recovery loop if the server fails between context and the first sync", async () => {
  const { client, contextStatus, syncs } = reconnectFixture();
  try {
    await client.attach(session("new"), "local-cookie");
    const pending = client.connect("https://server.example.test", "cloud-cookie");
    contextStatus(503);
    await pending;
    expect(client.status()).toMatchObject({ connected: true, error: "DESKTOP_SERVER_UNAVAILABLE" });
    contextStatus(200);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(syncs()).toBeGreaterThan(0);
    expect(client.status()).toMatchObject({ connected: true, error: null });
  } finally { client.disconnect(); }
});

it.each([401, 403])("[TC-PDDESKTOP-012] stops reconnecting when session access is revoked (%s)", async status => {
  const { client, contextStatus, syncs } = reconnectFixture();
  try {
    await client.attach(session("new"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    contextStatus(status);
    await expect(client.sync()).rejects.toMatchObject({ code: "DESKTOP_SESSION_EXPIRED" });
    expect(client.status()).toMatchObject({ connected: false, bridgeConnected: false });
    const before = syncs();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(syncs()).toBe(before);
  } finally { client.disconnect(); }
});

it("[TC-PDDESKTOP-012] replaces a bridge whose handshake never completes", async () => {
  const { client, sockets } = reconnectFixture(false);
  try {
    await client.attach(session("new"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(sockets.length).toBeGreaterThan(1);
    expect(sockets[0]?.readyState).toBe(WebSocket.CLOSED);
    sockets.at(-1)?.accept();
    expect(client.status()).toMatchObject({ connected: true, bridgeConnected: true });
  } finally { client.disconnect(); }
});

it("[TC-PDDESKTOP-012] retries an errored bridge even if no close event follows", async () => {
  const { client, sockets } = reconnectFixture();
  try {
    await client.attach(session("new"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    sockets[0]?.dispatchEvent(new Event("error"));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sockets.length).toBeGreaterThan(1);
    expect(client.status()).toMatchObject({ connected: true, bridgeConnected: true });
    client.disconnect();
    const before = sockets.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(sockets).toHaveLength(before);
  } finally { client.disconnect(); }
});
it("[TC-PDDESKTOP-012] never copies a previous local profile's cloud cache into a new profile", async () => {
  const { client } = fixture();
  await client.attach(session("old"), "old-local-cookie");
  expect(client.status()).toMatchObject({ serverUrl: "https://previous.example.test" });
  await client.attach(session("new"), "new-local-cookie");
  expect(client.status()).toMatchObject({ serverUrl: null, connected: false });
  expect(() => client.requireProfile(session("old"))).toThrow("Use the active local profile");
  expect(() => client.requireProfile(session("new"))).not.toThrow();
});
it("[TC-PDDESKTOP-012] does not resurrect a pending connection after disconnect", async () => {
  const { client, service } = fixture();
  await client.attach(session("new"), "local-cookie");
  let respond!: (value: Response) => void;
  spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(resolve => { respond = resolve; }));
  const connection = client.connect("https://server.example.test", "cloud-cookie");
  client.disconnect();
  respond(Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", organizations: [] }));
  await expect(connection).rejects.toMatchObject({ code: "DESKTOP_CONNECTION_CANCELLED" });
  expect(client.status()).toMatchObject({ connected: false });
  expect(service.connectionKey).toBe("");
});

it("[TC-PDDESKTOP-020] refuses server settings without a connected, active local profile", async () => {
  const { client } = fixture();
  await client.attach(session("old"), "local-cookie");
  const request = (who: string, path: string) => client.serverSettingsRequest(session(who), "GET", path, undefined, new AbortController().signal);
  await expect(request("new", "/fleet/settings")).rejects.toMatchObject({ code: "DESKTOP_PROFILE_REQUIRED" });
  await expect(request("old", "/fleet/settings")).rejects.toMatchObject({ code: "DESKTOP_NOT_CONNECTED" });
  for (const path of ["/account/settings", "//other.example.test/fleet/settings", "/fleet/settings?scope=other", "/fleet/settings/../scope"]) {
    await expect(request("old", path)).rejects.toMatchObject({ code: "DESKTOP_OPERATION_DENIED" });
  }
});

interface SentRequest { path: string; method: string; body: string | null }
function settingsFixture(): { client: DesktopClient; requests: SentRequest[] } {
  const { client } = fixture({ syncIntervalMs: 60_000, createSocket: () => new BridgeSocket() as unknown as WebSocket });
  const requests: SentRequest[] = [];
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    if (path === "/api/desktop/context") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", organizations: [] });
    if (path === "/api/desktop/sync") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", hostIds: {}, conflicts: [], records: [] });
    return Response.json({ forwarded: true });
  }, { preconnect: (): void => {} }));
  return { client, requests };
}

it("[TC-PDDESKTOP-024] rejects a server settings body that fails its schema before any request", async () => {
  const { client, requests } = settingsFixture();
  try {
    await client.attach(session("new"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    const request = (method: string, path: string, body: unknown): Promise<Response> =>
      client.serverSettingsRequest(session("new"), method, path, body, new AbortController().signal);
    const cloudflare = { apiToken: "token", zoneId: "zone", baseDomain: "example.com", accessPolicyId: "policy" };
    const invalid: Array<[string, string, unknown]> = [
      ["PUT", "/fleet/settings", { heartbeatSec: "fast" }],
      ["PUT", "/fleet/settings", { heartbeatSec: 30, scopeId: "another-organization" }],
      ["PUT", "/fleet/settings", [{ heartbeatSec: 30 }]],
      ["PUT", "/integrations/cloudflare", { ...cloudflare, zoneId: 7 }],
      ["PUT", "/integrations/cloudflare", { ...cloudflare, ownerId: "someone-else" }],
      ["POST", "/integrations/cloudflare/discover", { apiToken: "token", accountId: "other" }],
      ["POST", "/integrations/cloudflare/discover", {}],
      ["GET", "/fleet/settings", { heartbeatSec: 30 }],
      ["GET", "/hosts", {}],
      ["DELETE", "/integrations/cloudflare", { zoneId: "zone" }],
      ["DELETE", "/integrations/cloudflare", null],
    ];
    const before = requests.length;
    for (const [method, path, body] of invalid) {
      await expect(request(method, path, body), `${method} ${path} ${JSON.stringify(body)}`).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    }
    await expect(request("PATCH", "/fleet/settings", { heartbeatSec: 30 })).rejects.toMatchObject({ code: "DESKTOP_OPERATION_DENIED", statusCode: 403 });
    expect(requests.slice(before)).toEqual([]);
  } finally { client.disconnect(); }
});

it("[TC-PDDESKTOP-024] forwards only the validated server settings body", async () => {
  const { client, requests } = settingsFixture();
  try {
    await client.attach(session("new"), "local-cookie");
    await client.connect("https://server.example.test", "cloud-cookie");
    const request = (method: string, path: string, body: unknown): Promise<Response> =>
      client.serverSettingsRequest(session("new"), method, path, body, new AbortController().signal);
    const forwarded = (): SentRequest | undefined => requests.filter(sent => sent.path !== "/api/desktop/context").at(-1);

    expect((await request("PUT", "/fleet/settings", { heartbeatSec: 30, mcpUserTokens: true })).status).toBe(200);
    expect(forwarded()).toEqual({ path: "/api/fleet/settings", method: "PUT", body: JSON.stringify({ heartbeatSec: 30, mcpUserTokens: true }) });

    await request("PUT", "/integrations/cloudflare", { apiToken: "  token  ", zoneId: " zone ", baseDomain: " Example.COM ", accessPolicyId: "policy" });
    expect(forwarded()).toEqual({ path: "/api/integrations/cloudflare", method: "PUT", body: JSON.stringify({ apiToken: "token", zoneId: "zone", baseDomain: "example.com", accessPolicyId: "policy" }) });

    await request("POST", "/integrations/cloudflare/discover", { apiToken: " token " });
    expect(forwarded()).toEqual({ path: "/api/integrations/cloudflare/discover", method: "POST", body: JSON.stringify({ apiToken: "token" }) });

    await request("DELETE", "/integrations/cloudflare", undefined);
    expect(forwarded()).toEqual({ path: "/api/integrations/cloudflare", method: "DELETE", body: null });
    await request("GET", "/fleet/scope", undefined);
    expect(forwarded()).toEqual({ path: "/api/fleet/scope", method: "GET", body: null });
  } finally { client.disconnect(); }
});


it("[TC-PDDESKTOP-027] exposes only the authenticated server profile and clears it on sign out", async () => {
  const { client } = reconnectFixture();
  try {
    await client.attach(session("local-synthetic"), "local-cookie");
    expect(client.status()).toMatchObject({ connected: false, user: null });
    await client.connect("https://server.example.test", "cloud-cookie");
    expect(client.status()).toMatchObject({ connected: true, user: { id: "remote", name: "Remote user", email: "remote@example.test", role: "user" } });
    client.disconnect();
    expect(client.status()).toMatchObject({ connected: false, user: null });
  } finally { client.disconnect(); }
});

it("[TC-PDDESKTOP-027] cannot resurrect a profile lookup after disconnect", async () => {
  const { client } = fixture({ syncIntervalMs: 60_000 });
  let identityStarted!: () => void;
  const started = new Promise<void>(resolve => { identityStarted = resolve; });
  let identityComplete!: (response: Response) => void;
  const identity = new Promise<Response>(resolve => { identityComplete = resolve; });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/desktop/context") return Response.json({ version: 1, userId: "remote", scopeId: "personal:remote" });
    if (url.pathname === "/api/auth/get-session") { identityStarted(); return identity; }
    throw new Error("Unexpected identity test request");
  }, { preconnect: (): void => {} }));
  try {
    await client.attach(session("local"), "local-cookie");
    const pending = client.connect("https://server.example.test", "cloud-cookie");
    await started;
    client.disconnect();
    identityComplete(Response.json({ user: { id: "remote", name: "Old admin", email: "admin@example.test", role: "admin" } }));
    await pending;
    expect(client.status()).toMatchObject({ connected: false, user: null });
  } finally { client.disconnect(); }
});
