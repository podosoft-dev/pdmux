import { AuthenticatedWebSocket } from "./authenticated-websocket";
import { DESKTOP_BRIDGE_PATH, DESKTOP_PROTOCOL_VERSION, type SyncChange, type SyncConflict, type SyncRecord, type SyncResult, type BridgeRequest } from "@pdmux/desktop-protocol";
import type { Repository } from "typeorm";
import { z } from "zod";
import { AppException } from "../common/app-exception";
import type { AuthSession } from "../auth/auth.service";
import { DesktopConnection } from "./desktop-connection.entity";
import { DesktopService, recordHash } from "./desktop.service";
import { DesktopBridge, safeHeaders } from "./bridge";
import { hostRoute } from "./host-route";
import { terminalStream } from "./terminal-stream";

interface AccountState {
  url: string; userId: string; scopeId: string;
  bases: Record<string, { hash: string; record: SyncRecord }>;
  hostIds: Record<string, string>; conflicts: SyncConflict[]; organizations?: Array<{ id: string; name: string }>; history?: Array<{ at: string; conflict: SyncConflict; choice: "local" | "server" }>;
}
interface ClientState { deviceId: string; selected: string; accounts: Record<string, AccountState> }
const contextSchema = z.object({ version: z.literal(DESKTOP_PROTOCOL_VERSION), userId: z.string(), scopeId: z.string(), organizations: z.array(z.object({ id: z.string(), name: z.string() })).optional() });
const SERVER_SETTINGS_ROUTES = new Set([
  "GET /fleet/settings", "PUT /fleet/settings", "GET /fleet/scope", "GET /hosts",
  "GET /integrations/cloudflare", "PUT /integrations/cloudflare", "DELETE /integrations/cloudflare",
  "POST /integrations/cloudflare/discover",
]);

export class DesktopClient {
  private state: ClientState = { deviceId: crypto.randomUUID(), selected: "", accounts: {} };
  private session?: AuthSession;
  private localCookie = "";
  private cloudCookie = "";
  private timer?: ReturnType<typeof setInterval>;
  private socket?: WebSocket;
  private bridge?: DesktopBridge;
  private running = false;
  private epoch = 0;
  private connectionAbort = new AbortController();
  private readonly idleWaiters: Array<() => void> = [];
  private stopped = true;
  private error: string | null = null;
  private lastSync: string | null = null;
  constructor(private readonly service: DesktopService, private readonly store: Repository<DesktopConnection>) {}

  async attach(session: AuthSession, cookie: string): Promise<void> {
    if (this.session?.user.id !== session.user.id) {
      this.disconnect();
      await this.idle();
      const saved = await this.store.findOneBy({ userId: session.user.id });
      if (saved) this.state = saved.state as unknown as ClientState;
      else { this.state = { deviceId: crypto.randomUUID(), selected: "", accounts: {} }; await this.save(session.user.id); }
    }
    this.session = session; this.localCookie = cookie;
    this.service.origin = this.state.deviceId;
    this.service.connectionKey = this.state.selected;
  }
  requireProfile(session: AuthSession): void {
    if (!this.session || session.user.id !== this.session.user.id) throw new AppException("DESKTOP_PROFILE_REQUIRED", "Use the active local profile", 404);
  }
  hostId(key: string): string | undefined { return this.state.accounts[this.state.selected]?.hostIds[key]; }
  status(): object {
    const account = this.state.accounts[this.state.selected];
    return { local: true, connected: !this.stopped, bridgeConnected: this.socket?.readyState === WebSocket.OPEN,
      serverUrl: account?.url ?? null, userId: account?.userId ?? null, scopeId: account?.scopeId ?? null,
      organizations: account?.organizations ?? [], lastSync: this.lastSync, error: this.error, conflicts: account?.conflicts ?? [] };
  }
  private async save(userId = this.session?.user.id): Promise<void> {
    if (userId) await this.store.save({ userId, state: JSON.parse(JSON.stringify(this.state)) as Record<string, unknown> });
  }
  async connect(url: string, cookie: string): Promise<void> {
    if (!this.session) throw new AppException("DESKTOP_PROFILE_REQUIRED", "No local profile", 409);
    const startingEpoch = this.epoch;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new AppException("DESKTOP_SERVER_INVALID", "Use an HTTPS server origin", 400);
    const response = await fetch(`${parsed.origin}/api/desktop/context`, { headers: { cookie }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppException("DESKTOP_SERVER_UNAVAILABLE", "The server does not support desktop connections or requires login", response.status === 401 ? 401 : 409);
    const context = contextSchema.parse(await response.json());
    if (startingEpoch !== this.epoch) throw new AppException("DESKTOP_CONNECTION_CANCELLED", "Connection was cancelled", 409);
    this.disconnect();
    const connectingEpoch = this.epoch;
    await this.idle();
    if (connectingEpoch !== this.epoch) throw new AppException("DESKTOP_CONNECTION_CANCELLED", "Connection was cancelled", 409);
    this.connectionAbort = new AbortController();
    const key = recordHash([parsed.origin, context.userId, context.scopeId]);
    this.state.accounts[key] ??= { url: parsed.origin, userId: context.userId, scopeId: context.scopeId, bases: {}, hostIds: {}, conflicts: [] };
    this.state.accounts[key]!.organizations = context.organizations ?? [];
    this.state.selected = key; this.service.connectionKey = key;
    this.cloudCookie = cookie; this.stopped = false;
    await this.save();
    await this.sync();
    if (this.stopped) return;
    this.openBridge();
    this.timer = setInterval(() => {
      void this.sync().catch(() => undefined);
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.openBridge();
    }, 5_000);
  }
  private async idle(): Promise<void> { if (this.running) await new Promise<void>(resolve => this.idleWaiters.push(resolve)); }
  disconnect(): void {
    this.epoch += 1; this.connectionAbort.abort();
    this.stopped = true; this.cloudCookie = "";
    clearInterval(this.timer); this.timer = undefined;
    this.bridge?.close(); this.bridge = undefined;
    this.socket?.close(); this.socket = undefined;
  }
  private account(): AccountState {
    const account = this.state.accounts[this.state.selected];
    if (!account) throw new AppException("DESKTOP_NOT_CONNECTED", "No server connection", 409);
    return account;
  }
  /** Settings belong to the selected server, never to a synchronized local copy. */
  async serverSettingsRequest(session: AuthSession, method: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    this.requireProfile(session);
    if (!SERVER_SETTINGS_ROUTES.has(`${method} ${path}`)) throw new AppException("DESKTOP_OPERATION_DENIED", "Unsupported server settings operation", 403);
    if (this.stopped) throw new AppException("DESKTOP_NOT_CONNECTED", "Sign in to configure the server", 409);
    const epoch = this.epoch;
    const account = this.account();
    await this.checkSession();
    if (epoch !== this.epoch || this.stopped) throw new AppException("DESKTOP_CONNECTION_CANCELLED", "Connection was cancelled", 409);
    const response = await fetch(`${account.url}/api${path}`, {
      method, headers: { cookie: this.cloudCookie, origin: account.url, "content-type": "application/json" },
      body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, this.connectionAbort.signal, AbortSignal.timeout(15_000)]), redirect: "error",
    });
    if (epoch !== this.epoch || this.stopped) throw new AppException("DESKTOP_CONNECTION_CANCELLED", "Connection was cancelled", 409);
    return new Response(response.body, { status: response.status, headers: safeHeaders(response.headers) });
  }
  async cloudRequest(input: BridgeRequest, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response> {
    if (this.stopped) throw new AppException("DESKTOP_SERVER_OFFLINE", "Sign in to use server hosts", 503);
    const account = this.account();
    const id = account.hostIds[input.hostKey];
    if (!id) throw new AppException("HOST_NOT_FOUND", "Unknown server host", 404);
    if (input.method === "WS") return terminalStream(`${account.url.replace(/^https/, "wss")}/terminal/ws?hostId=${encodeURIComponent(id)}`, this.cloudCookie, body ?? new ReadableStream({ start(c) { c.close(); } }), signal);
    const route = hostRoute(input.method, input.path);
    if (!route) throw new AppException("DESKTOP_OPERATION_DENIED", "Unsupported host operation", 403);
    const response = await fetch(`${account.url}/api${route.rewrite(id)}`, {
      method: input.method, headers: { ...input.headers, cookie: this.cloudCookie, origin: account.url },
      body: input.method === "GET" ? undefined : body, signal: AbortSignal.any([signal, this.connectionAbort.signal]), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) await this.checkSession();
    return response;
  }
  private async checkSession(): Promise<void> {
    const account = this.account();
    const response = await fetch(`${account.url}/api/desktop/context`, { headers: { cookie: this.cloudCookie }, signal: AbortSignal.any([AbortSignal.timeout(10_000), this.connectionAbort.signal]), redirect: "error" });
    if (!response.ok) { this.disconnect(); throw new AppException("DESKTOP_SESSION_EXPIRED", "Sign in again", 401); }
    const context = contextSchema.parse(await response.json());
    if (context.userId !== account.userId || context.scopeId !== account.scopeId) { this.disconnect(); throw new AppException("DESKTOP_SCOPE_CHANGED", "Reconnect after switching workspace", 409); }
  }
  async sync(resolution?: { key: string; choice: "local" | "server" }): Promise<void> {
    if (this.running) { if (resolution) throw new AppException("DESKTOP_SYNC_BUSY", "Synchronization is in progress", 409); return; }
    if (this.stopped || !this.session) return;
    const epoch = this.epoch;
    this.running = true;
    const account = this.account();
    try {
      await this.checkSession();
      if (epoch !== this.epoch) return;
      const release = await this.service.lock.acquire(this.service.syncKeys(this.session));
      try {
        const records = await this.service.snapshot(this.session);
        const current = new Map(records.map(record => [record.key, record]));
        const changes: SyncChange[] = records.map(record => ({ ...record, base: account.bases[record.key]?.hash ?? null }));
        for (const [key, base] of Object.entries(account.bases)) {
          if (!current.has(key)) changes.push({ ...base.record, value: null, base: base.hash });
        }
        if (resolution) {
          const conflict = account.conflicts.find(item => item.key === resolution.key);
          const change = changes.find(item => item.key === resolution.key);
          if (change && conflict) { account.history = [...(account.history ?? []), { at: new Date().toISOString(), conflict, choice: resolution.choice }].slice(-20); await this.save(); change.resolution = resolution.choice; change.resolutionBase = conflict.serverHash; }
        }
        const response = await fetch(`${account.url}/api/desktop/sync`, {
          method: "POST", headers: { cookie: this.cloudCookie, origin: account.url, "content-type": "application/json" }, redirect: "error",
          body: JSON.stringify({ version: DESKTOP_PROTOCOL_VERSION, deviceId: this.state.deviceId, name: "PDMux Desktop", changes }), signal: AbortSignal.any([AbortSignal.timeout(30_000), this.connectionAbort.signal]),
        });
        if (!response.ok) throw new AppException("DESKTOP_SYNC_FAILED", "Synchronization failed", response.status);
        const result = await response.json() as SyncResult;
        if (epoch !== this.epoch) return;
        if (result.version !== DESKTOP_PROTOCOL_VERSION || result.userId !== account.userId || result.scopeId !== account.scopeId || !Array.isArray(result.records)) throw new Error("Invalid sync response");
        account.hostIds = result.hostIds;
        for (const record of [...result.records].sort((a, b) => Number(b.kind === "host") - Number(a.kind === "host"))) {
          if (epoch !== this.epoch) return;
          if (result.conflicts.some(conflict => conflict.key === record.key)) continue;
          if (recordHash(current.get(record.key)?.value ?? null) !== record.hash || !current.has(record.key)) await this.service.apply(this.session, record);
          account.bases[record.key] = { hash: record.hash, record };
        }
        account.conflicts = result.conflicts;
        this.lastSync = new Date().toISOString(); this.error = null;
        await this.save();
      } finally { release(); }
    } catch (error) {
      this.error = error instanceof AppException ? error.code : "DESKTOP_SYNC_FAILED";
      throw error;
    } finally { this.running = false; for (const resolve of this.idleWaiters.splice(0)) resolve(); }
  }
  private openBridge(): void {
    if (this.stopped) return;
    const account = this.account();
    const url = `${account.url.replace(/^https/, "wss")}${DESKTOP_BRIDGE_PATH}?deviceId=${encodeURIComponent(this.state.deviceId)}&version=${DESKTOP_PROTOCOL_VERSION}`;
    const socket = new AuthenticatedWebSocket(url, { headers: { cookie: this.cloudCookie, origin: account.url } });
    this.socket = socket;
    const bridge = new DesktopBridge(data => {
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1008, "slow peer"); throw new Error("Bridge buffer exceeded"); }
      socket.send(data);
    }, (input, body, signal) => this.localRequest(input, body, signal), () => socket.close(1008));
    this.bridge = bridge;
    socket.addEventListener("message", event => bridge.receive(event.data));
    socket.addEventListener("error", () => { this.error = "DESKTOP_BRIDGE_UNAVAILABLE"; });
    socket.addEventListener("close", () => { bridge.close(); });
  }
  private async localRequest(input: BridgeRequest, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Response> {
    if (this.stopped || !this.session) throw new AppException("DESKTOP_OFFLINE", "Desktop disconnected", 503);
    const binding = (await this.service.bindings(this.session)).find(row => row.key === input.hostKey && row.origin === this.state.deviceId);
    if (!binding?.hostId || !binding.value) throw new AppException("HOST_NOT_FOUND", "Unknown local host", 404);
    const origin = process.env.BETTER_AUTH_URL;
    if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("Missing local API");
    if (input.method === "WS") return terminalStream(`${origin.replace(/^http/, "ws")}/terminal/ws?hostId=${binding.hostId}`, this.localCookie, body, signal);
    const route = hostRoute(input.method, input.path);
    if (!route) throw new AppException("DESKTOP_OPERATION_DENIED", "Unsupported host operation", 403);
    const response = await fetch(`${origin}${route.rewrite(binding.hostId)}`, {
      method: input.method, headers: { ...input.headers, cookie: this.localCookie, origin: process.env.CORS_ORIGIN ?? origin },
      body: input.method === "GET" ? undefined : body, signal, redirect: "error",
    });
    // Strip local cookies, redirects and all response metadata unrelated to host data.
    return new Response(response.body, { status: response.status, headers: safeHeaders(response.headers) });
  }
}
