import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { Repository } from "typeorm";
import { DesktopClient, type DesktopClientOptions } from "./desktop-client";
import type { DesktopService } from "./desktop.service";
import { KeyedMutex } from "./keyed-mutex";
import type { DesktopConnection } from "./desktop-connection.entity";
const session = (id: string) => ({ user: { id }, session: {} });
afterEach(() => mock.restore());
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
