import { getAuth } from "../auth/auth-provider";
import { DesktopAgentCache } from "./agent-cache";
import { resolveScopeId } from "../fleet/session-scope";
import { Elysia, t } from "elysia";
import { DESKTOP_BRIDGE_PATH, DESKTOP_PROTOCOL_VERSION, MAX_FRAME_BYTES } from "@pdmux/desktop-protocol";
import { AppException } from "../common/app-exception";
import { ACCESS_POLICY, type PodokitModule, type ServiceKey } from "../core/services";
import { PDMUX } from "../pdmux/pdmux.services";
import type { AuthSession } from "../auth/auth.service";
import { DesktopRecord } from "./desktop-record.entity";
import { DesktopConnection } from "./desktop-connection.entity";
import { DesktopService, prefsLockKey } from "./desktop.service";
import { DesktopClient } from "./desktop-client";
import { DesktopBridge } from "./bridge";
import { DesktopRouter, requireCurrentScope } from "./desktop-router";
import { isDesktopRuntime, requireDesktopCapability } from "./local-auth";

export const DESKTOP = Symbol("desktop") as ServiceKey<DesktopRouter>;
export const DESKTOP_HTTP_ROUTES = ["GET /desktop/capabilities", "GET /desktop/context", "POST /desktop/sync", "GET /desktop/status", "POST /desktop/resolve", "PUT /desktop/appearance", "GET /desktop/agents", "GET /desktop/appearance", "GET /desktop/agents/:version", "GET /desktop/agents/:version/:file", "POST /desktop/agents/:version/prefetch"] as const;

export const desktopModule: PodokitModule = {
  name: "pdmux.desktop",
  configure: (_env, services) => {
    const pdmux = services.resolve(PDMUX);
    const service = new DesktopService(pdmux, pdmux.dataSource.getRepository(DesktopRecord));
    const client = isDesktopRuntime() ? new DesktopClient(service, pdmux.dataSource.getRepository(DesktopConnection)) : null;
    const router = new DesktopRouter(service, client);
    pdmux.hosts.setNativeConnectionGuard(async (scope, id) => {
      const rows = await pdmux.dataSource.getRepository(DesktopRecord).find({ where: { scopeId: scope, hostId: id } });
      if (rows.some(row => row.origin !== service.origin)) throw new AppException("DESKTOP_OPERATION_DENIED", "Manage host credentials on its original backend", 403);
    });
    services.register(DESKTOP, router, () => router.close());
    const policy = services.resolve(ACCESS_POLICY);
    policy.register("GET", "/desktop/capabilities", "public");
    policy.register("POST", "/desktop/local/control", "public");
    policy.register("GET", "/desktop/agents/:version/:file", "public");
    policy.register("*", DESKTOP_BRIDGE_PATH, "public");
  },
  plugin: ({ services }) => {
    const router = services.resolve(DESKTOP);
    const pdmux = router.service.pdmux;
    const agents = new DesktopAgentCache();
    const contexts = new WeakMap<Request, { session: AuthSession; deviceId: string }>();
    const peers = new WeakMap<object, { bridge: DesktopBridge; close: () => void; alive: boolean }>();
    return new Elysia({ name: "pdmux.desktop" })
      .get("/desktop/capabilities", () => ({ version: DESKTOP_PROTOCOL_VERSION, local: isDesktopRuntime() }))
      .get("/desktop/context", async ({ request }) => {
        const session = await pdmux.auth.requireSession(request); await requireCurrentScope(session);
        const auth = await getAuth().$context;
        const members = await auth.adapter.findMany<{ organizationId: string }>({ model: "member", where: [{ field: "userId", value: session.user.id }], limit: 100 });
        const organizations = await Promise.all(members.map(member => auth.adapter.findOne<{ id: string; name: string }>({ model: "organization", where: [{ field: "id", value: member.organizationId }] })));
        return { version: DESKTOP_PROTOCOL_VERSION, userId: session.user.id, scopeId: resolveScopeId(session), organizations: organizations.filter((value): value is { id: string; name: string } => value !== null).map(({ id, name }) => ({ id, name })) };
      })
      .post("/desktop/sync", async ({ request, body }) => {
        const session = await pdmux.auth.requireSession(request); await requireCurrentScope(session);
        return router.service.sync(session, body);
      }, { body: t.Unknown() })
      .get("/desktop/agents", () => agents.current())
      .get("/desktop/appearance", async ({ request }) => {
        const session = await pdmux.auth.requireSession(request);
        return (await router.service.bindings(session)).find(row => row.kind === "appearance")?.value ?? null;
      })
      .get("/desktop/agents/:version", ({ params }) => agents.list(params.version))
      .get("/desktop/agents/:version/:file", async ({ params }) => new Response(Bun.file(await agents.ensure(params.version, params.file)), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } }))
      .post("/desktop/agents/:version/prefetch", async ({ params, body }) => { await agents.ensure(params.version, body.file); return agents.list(params.version); }, { body: t.Object({ file: t.String() }) })
      .get("/desktop/status", async ({ request }) => {
        if (router.client) router.client.requireProfile(await pdmux.auth.requireSession(request));
        return router.client?.status() ?? { local: false };
      })
      .post("/desktop/resolve", async ({ request, body }) => {
        if (!router.client) throw new AppException("DESKTOP_REQUIRED", "This action needs the desktop app", 409);
        router.client.requireProfile(await pdmux.auth.requireSession(request));
        await router.client.sync(body); return router.client.status();
      }, { body: t.Object({ key: t.String({ maxLength: 256 }), choice: t.Union([t.Literal("local"), t.Literal("server")]) }) })
      .put("/desktop/appearance", async ({ request, body }) => {
        const session = await pdmux.auth.requireSession(request);
        await router.service.lock.run([prefsLockKey(session)], () => router.service.apply(session, { key: "appearance", kind: "appearance", origin: "personal", value: body }));
        return body;
      }, { body: t.Object({ theme: t.Union([t.Literal("light"), t.Literal("dark"), t.Literal("system")]), locale: t.Union([t.Literal("en"), t.Literal("ko")]) }) })
      .post("/desktop/local/control", async ({ request, body }) => {
        try { requireDesktopCapability(request); } catch { throw new AppException("NOT_FOUND", "Not found", 404); }
        if (!router.client) throw new AppException("DESKTOP_REQUIRED", "Desktop runtime is not active", 404);
        const session = await pdmux.auth.requireSession(request);
        await router.client.attach(session, request.headers.get("cookie") ?? "");
        if (body.action === "connect") {
          if (!body.url || !body.cookie) throw new AppException("DESKTOP_SERVER_INVALID", "Missing server connection", 400);
          await router.client.connect(body.url, body.cookie);
        } else if (body.action === "disconnect") router.client.disconnect();
        return router.client.status();
      }, { body: t.Object({ action: t.Union([t.Literal("attach"), t.Literal("connect"), t.Literal("disconnect")]), url: t.Optional(t.String()), cookie: t.Optional(t.String()) }), detail: { hide: true } })
      .ws(DESKTOP_BRIDGE_PATH, {
        maxPayloadLength: MAX_FRAME_BYTES,
        beforeHandle: async ({ request }) => {
          try {
            if (router.client) throw new AppException("DESKTOP_OPERATION_DENIED", "A desktop cannot host another bridge", 403);
            const origin = request.headers.get("origin");
            const allowed = (process.env.CORS_ORIGIN ?? "").split(",").map(value => value.trim());
            if (!origin || !allowed.includes(origin)) throw new AppException("DESKTOP_ORIGIN_DENIED", "Origin is not allowed", 403);
            const session = await pdmux.auth.requireSession(request); await requireCurrentScope(session);
            const url = new URL(request.url); const deviceId = url.searchParams.get("deviceId") ?? "";
            if (!/^[0-9a-f-]{36}$/i.test(deviceId) || url.searchParams.get("version") !== String(DESKTOP_PROTOCOL_VERSION)) throw new AppException("DESKTOP_PROTOCOL_UNSUPPORTED", "Unsupported desktop protocol", 400);
            contexts.set(request, { session, deviceId });
          } catch (error) {
            return Response.json({ success: false, error: { code: error instanceof AppException ? error.code : "DESKTOP_AUTH_REQUIRED", message: "Desktop connection rejected" } }, { status: error instanceof AppException ? error.statusCode : 401 });
          }
          return undefined;
        },
        open: ws => {
          const context = contexts.get(ws.data.request); contexts.delete(ws.data.request);
          if (!context) { ws.close(1008); return; }
          const bridge = new DesktopBridge(data => { if (ws.send(data) === -1) ws.close(1008, "slow peer"); }, async () => new Response(null, { status: 403 }), () => ws.close(1008));
          const unregister = router.register(context.session, context.deviceId, { bridge, close: () => ws.close(1000) });
          let checking = false;
          const timer = setInterval(() => {
            if (checking) return;
            const peer = peers.get(ws.raw);
            if (!peer?.alive) { ws.close(1008, "ping timeout"); return; }
            peer.alive = false;
            checking = true;
            void pdmux.auth.requireSession(new Request(ws.data.request.url, { headers: ws.data.request.headers })).then(async current => {
              await requireCurrentScope(current);
              if (router.peerKey(current, context.deviceId) !== router.peerKey(context.session, context.deviceId)) ws.close(1008, "workspace changed");
              else ws.raw.ping();
            }).catch(() => ws.close(1008, "session expired")).finally(() => { checking = false; });
          }, 5_000);
          peers.set(ws.raw, { bridge, alive: true, close: () => { clearInterval(timer); unregister(); } });
        },
        message: (ws, message) => peers.get(ws.raw)?.bridge.receive(typeof message === "string" ? message : JSON.stringify(message)),
        pong: ws => { const peer = peers.get("raw" in ws ? ws.raw : ws); if (peer) peer.alive = true; },
        close: ws => { peers.get(ws.raw)?.close(); peers.delete(ws.raw); },
      });
  },
};
