import { afterEach, describe, expect, it } from "bun:test";
import { DESKTOP_BRIDGE_PATH, DESKTOP_PROTOCOL_VERSION } from "@pdmux/desktop-protocol";
import { Elysia } from "elysia";
import type { AuthSession } from "../auth/auth.service";
import { ServiceRegistry, type AppContext } from "../core/services";
import { GOING_AWAY, Shutdown } from "../core/shutdown";
import { AuthenticatedWebSocket } from "./authenticated-websocket";
import { DESKTOP, desktopModule } from "./desktop.module";
import type { DesktopRouter } from "./desktop-router";

const ORIGIN = "http://desktop.test";
const DEVICE = "6f1c1c4e-2f0a-4d0e-9a4b-3c1d2e3f4a5b";
const previousOrigin = process.env.CORS_ORIGIN;

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = previousOrigin;
});

function bridgeApp(shutdown: Shutdown): { app: Elysia; peers: () => number } {
  // No active organization, so the bridge needs no membership lookup.
  const session: AuthSession = { user: { id: "user-1" } as AuthSession["user"], session: {} };
  let peers = 0;
  const router = {
    client: null,
    service: { pdmux: { auth: { requireSession: async (): Promise<AuthSession> => session } } },
    peerKey: (): string => "user-1:personal:user-1:" + DEVICE,
    register: (): (() => void) => {
      peers += 1;
      return () => { peers -= 1; };
    },
  } as unknown as DesktopRouter;
  const services = new ServiceRegistry();
  services.register(DESKTOP, router);
  const plugin = desktopModule.plugin?.({ services, shutdown } as unknown as AppContext);
  if (!plugin) throw new Error("The desktop module has no plugin");
  const app = new Elysia().use(plugin).listen({ hostname: "127.0.0.1", port: 0 });
  return { app, peers: () => peers };
}

describe("[TC-PDAGENT-130] a stopping API ends the desktop bridge at once", () => {
  it("closes the bridge with GOING_AWAY and releases its peer", async () => {
    process.env.CORS_ORIGIN = ORIGIN;
    const shutdown = new Shutdown();
    const { app, peers } = bridgeApp(shutdown);
    const port = app.server?.port;
    if (port === undefined) throw new Error("Bridge test server did not start");
    const socket = new AuthenticatedWebSocket(
      `ws://127.0.0.1:${port}${DESKTOP_BRIDGE_PATH}?deviceId=${DEVICE}&version=${DESKTOP_PROTOCOL_VERSION}`,
      { headers: { origin: ORIGIN } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Bridge failed to open")), { once: true });
      });
      const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
      const deadline = Date.now() + 2_000;
      while (peers() !== 1 && Date.now() < deadline) await Bun.sleep(10);
      expect(peers()).toBe(1);
      shutdown.begin();
      // The desktop reopens its bridge on its next sync tick, against the next instance.
      expect(await closed).toBe(GOING_AWAY);
      const released = Date.now() + 2_000;
      while (peers() !== 0 && Date.now() < released) await Bun.sleep(10);
      expect(peers()).toBe(0);
    } finally {
      socket.close();
      await app.stop(true);
    }
  });
});
