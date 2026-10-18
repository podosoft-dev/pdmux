import type { BridgeRequest } from "@pdmux/desktop-protocol";
import { AppException } from "../common/app-exception";
import type { AuthSession } from "../auth/auth.service";
import { getAuth } from "../auth/auth-provider";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { DesktopBridge, safeHeaders } from "./bridge";
import type { DesktopClient } from "./desktop-client";
import type { DesktopService } from "./desktop.service";
import type { DesktopRecord } from "./desktop-record.entity";
import { hostRoute, metadataWrite } from "./host-route";

interface Peer { bridge: DesktopBridge; close: () => void }
export interface TerminalSocket { send(data: string): unknown; close(code?: number, reason?: string): void }
interface TerminalChannel { controller: ReadableStreamDefaultController<Uint8Array>; abort: AbortController; queued: number }

export async function requireCurrentScope(session: AuthSession): Promise<void> {
  const org = session.session.activeOrganizationId;
  if (typeof org !== "string" || !org) return;
  const context = await getAuth().$context;
  const member = await context.adapter.findOne({ model: "member", where: [{ field: "organizationId", value: org }, { field: "userId", value: session.user.id }] });
  if (!member) throw new AppException("DESKTOP_SCOPE_REVOKED", "Workspace access was revoked", 403);
}

export class DesktopRouter {
  private readonly peers = new Map<string, Peer>();
  private readonly releases = new WeakMap<Request, () => void>();
  private readonly terminals = new Map<TerminalSocket, TerminalChannel>();
  constructor(readonly service: DesktopService, readonly client: DesktopClient | null) {}
  peerKey(session: AuthSession, deviceId: string): string { return `${session.user.id}:${resolveScopeId(session)}:${deviceId}`; }
  register(session: AuthSession, deviceId: string, peer: Peer): () => void {
    const key = this.peerKey(session, deviceId);
    this.peers.get(key)?.close(); this.peers.set(key, peer);
    return () => { if (this.peers.get(key) === peer) this.peers.delete(key); peer.bridge.close(); };
  }
  async forward(request: Request, parsedBody?: unknown): Promise<Response | undefined> {
    const url = new URL(request.url);
    const route = hostRoute(request.method, `${url.pathname}${url.search}`);
    const hostId = /^\/(?:hosts|terminal)\/([0-9a-f-]{36})(?:\/|$)/i.exec(url.pathname)?.[1];
    const session = hostId || route || metadataWrite(request.method, url.pathname) ? await this.service.pdmux.auth.requireSession(request) : null;
    if (!session) return undefined;
    const binding = hostId ? await this.service.binding(session, hostId) : undefined;
    if (binding && binding.origin !== this.service.origin) {
      if (!route) throw new AppException("DESKTOP_OPERATION_DENIED", "Manage host credentials on its original backend", 403);
      await this.service.pdmux.hosts.get(resolveScopeId(session), route.hostId);
      await requireCurrentScope(session);
      if ((metadataWrite(request.method, url.pathname) || /\/agent\/update$/.test(url.pathname)) && request.method !== "GET") assertCanManageFleet(session);
      let response: Response;
      const headers = safeHeaders(request.headers); delete headers["content-length"];
      const body = request.bodyUsed && parsedBody !== undefined ? new Blob([JSON.stringify(parsedBody)]).stream() : request.body;
      try { response = await this.request(session, binding, { hostKey: binding.key, method: request.method as BridgeRequest["method"], path: `${url.pathname}${url.search}`, headers }, body, request.signal); }
      catch (error) {
        if (request.method === "GET" && url.pathname === `/hosts/${hostId}`) {
          const native = await this.service.pdmux.hosts.getView(resolveScopeId(session), hostId!);
          return Response.json((await this.views(session, [native]))[0]);
        }
        throw error;
      }
      return this.translateResponse(response, binding, url.pathname);
    }
    // Do not expose stale cached rows belonging to a different account.
    if (route && !binding && await this.service.hasForeignBinding(route.hostId)) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
    if (metadataWrite(request.method, url.pathname)) this.releases.set(request, await this.service.lock.acquire(this.service.writeKeys(session, url.pathname)));
    return undefined;
  }
  release(request: Request): void { this.releases.get(request)?.(); this.releases.delete(request); }

  private async translateResponse(response: Response, binding: DesktopRecord, path: string): Promise<Response> {
    if (/\/files\/(?:content|download)$|\/file-transfers\/[^/]+\/download$/.test(path)) return response;
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
    const value: unknown = await response.json();
    const sourceId = this.client ? this.clientHostId(binding.key) : binding.key.slice(binding.key.lastIndexOf(":") + 1);
    const replace = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(replace);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, (key === "id" || key === "hostId") && entry === sourceId ? binding.hostId : replace(entry)]));
      return item;
    };
    const translated = replace(value);
    const result = path === `/hosts/${binding.hostId}` && translated && typeof translated === "object" ? { ...translated, origin: { kind: this.client ? "server" : "desktop", readOnly: false } } : translated;
    return Response.json(result, { status: response.status, headers: { "cache-control": "no-store" } });
  }
  private clientHostId(key: string): string | undefined { return this.client?.hostId(key); }
  async request(session: AuthSession, binding: DesktopRecord, input: BridgeRequest, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response> {
    if (!binding.value || !binding.hostId) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
    if (this.client) { this.client.requireProfile(session); return this.client.cloudRequest(input, body, signal); }
    const peer = this.peers.get(`${binding.userId}:${resolveScopeId(session)}:${binding.origin}`);
    if (!peer) throw new AppException("DESKTOP_OFFLINE", "The desktop must be running and signed in", 503);
    return peer.bridge.request(input, body, signal);
  }
  async views(session: AuthSession, hosts: Awaited<ReturnType<DesktopService["pdmux"]["hosts"]["list"]>>): Promise<object[]> {
    const rows = await this.service.bindings(session);
    const output: object[] = [];
    for (const host of hosts) {
      const binding = rows.find(row => row.hostId === host.id && row.kind === "host");
      if (!binding) { if (!await this.service.hasForeignBinding(host.id)) output.push(host); continue; }
      if (binding.origin === this.service.origin) { output.push({ ...host, origin: { kind: "local", readOnly: false } }); continue; }
      let view = binding.cachedView ?? { ...host, ...binding.value, services: host.services };
      let connected = false;
      try {
        const response = await this.request(session, binding, { hostKey: binding.key, method: "GET", path: `/hosts/${host.id}`, headers: {} }, null, AbortSignal.timeout(5_000));
        if (response.ok) { view = await response.json() as Record<string, unknown>; connected = true; await this.service.cacheView(binding, view); }
      } catch { /* Cached metadata remains usable while the original owner is offline. */ }
      output.push({ ...view, id: host.id, connected: connected && view.connected === true,
        origin: { kind: this.client ? "server" : "desktop", readOnly: !connected, deviceId: binding.origin } });
    }
    return output;
  }
  async terminalBinding(request: Request): Promise<{ session: AuthSession; binding: DesktopRecord; request: Request } | null> {
    const session = await this.service.pdmux.auth.requireSession(request);
    await requireCurrentScope(session);
    const id = new URL(request.url).searchParams.get("hostId") ?? "";
    const binding = await this.service.binding(session, id);
    if (binding && binding.origin !== this.service.origin) return { session, binding, request };
    if (!binding && await this.service.hasForeignBinding(id)) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
    return null;
  }
  openTerminal(socket: TerminalSocket, target: { session: AuthSession; binding: DesktopRecord; request: Request }): void {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull: () => { const channel = this.terminals.get(socket); if (channel) channel.queued = 0; } });
    const abort = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return; checking = true;
      void this.service.pdmux.auth.requireSession(new Request(target.request.url, { headers: target.request.headers })).then(async current => {
        await requireCurrentScope(current);
        if (current.user.id !== target.session.user.id || resolveScopeId(current) !== resolveScopeId(target.session)) throw new Error("Workspace changed");
        const host = await this.service.pdmux.hosts.get(resolveScopeId(current), target.binding.hostId!);
        if (!host.enabled) throw new Error("Host disabled");
      }).catch(() => { this.closeTerminal(socket); socket.close(1008, "permission revoked"); }).finally(() => { checking = false; });
    }, 5_000);
    abort.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    this.terminals.set(socket, { controller, abort, queued: 0 });
    void this.request(target.session, target.binding, { hostKey: target.binding.key, method: "WS", path: "/terminal/ws", headers: {} }, stream, abort.signal).then(async response => {
      if (!response.ok || !response.body) throw new Error("Terminal unavailable");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "";
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          if (pending.length > 1024 * 1024) throw new Error("Terminal frame exceeded");
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            if (socket.send(pending.slice(0, newline)) === -1) throw new Error("Terminal consumer is too slow");
            pending = pending.slice(newline + 1);
          }
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
    }).catch(() => socket.close(1011, "desktop unavailable")).finally(() => { this.closeTerminal(socket); socket.close(1000); });
  }
  terminalMessage(socket: TerminalSocket, value: unknown): boolean {
    const channel = this.terminals.get(socket); if (!channel) return false;
    const data = new TextEncoder().encode(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    channel.queued += data.byteLength;
    if (channel.queued > 1024 * 1024) { this.closeTerminal(socket); socket.close(1008); }
    else channel.controller.enqueue(data);
    return true;
  }
  closeTerminal(socket: TerminalSocket): void {
    const channel = this.terminals.get(socket); if (!channel) return;
    this.terminals.delete(socket); channel.abort.abort(); try { channel.controller.close(); } catch { /* Closed by peer. */ }
  }
  close(): void { this.client?.disconnect(); for (const peer of this.peers.values()) peer.close(); this.peers.clear(); for (const socket of this.terminals.keys()) { this.closeTerminal(socket); socket.close(1001); } }
}
