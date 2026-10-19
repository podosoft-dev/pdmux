import { describe, expect, it, mock } from "bun:test";
import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { Elysia } from "elysia";
import { databaseUnavailable } from "../auth/database-outage";
import type { AppContext } from "../core/services";
import { GOING_AWAY, Shutdown } from "../core/shutdown";
import type { PdmuxGateway } from "./pdmux.gateway";
import { createPdmuxWsPlugin } from "./pdmux.ws";

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for WebSocket event"));
      }
    }, 10);
  });
}

function pingSocket(socket: unknown): void {
  if (
    typeof socket !== "object" ||
    socket === null ||
    !("ping" in socket) ||
    typeof socket.ping !== "function"
  ) {
    throw new Error("WebSocket transport did not expose a ping method");
  }
  socket.ping();
}

function context(shutdown: Shutdown): AppContext {
  return { shutdown } as unknown as AppContext;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
}

/** A shutdown whose listeners can be counted, so an unregistered socket shows. */
class CountingShutdown extends Shutdown {
  active = 0;

  override onShutdown(listener: () => void): () => void {
    this.active += 1;
    const stop = super.onShutdown(listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.active -= 1;
      stop();
    };
  }
}

function shutdownGateway(): { gateway: PdmuxGateway; agentClose: ReturnType<typeof mock>; terminalClose: ReturnType<typeof mock> } {
  const agentClose = mock((_socket: unknown) => undefined);
  const terminalClose = mock((_socket: unknown, _code: number, _reason: string) => undefined);
  const gateway = {
    authorizeAgent: mock(async () => ({
      hostId: "host-1", organizationId: "org-1", tokenId: "token-1", tokenExpiresAt: null, verify: false,
    })),
    openAgent: mock(async () => undefined),
    agentMessage: mock(() => undefined),
    agentPong: mock(() => undefined),
    agentClose,
    authorizeTerminal: mock(async () => ({
      hostId: "host-1",
      hostLabel: "Host",
      principal: { userId: "user-1", userName: "User", userEmail: "user@example.com", scopeId: "personal:user-1" },
      bufferBytes: 1_024,
    })),
    openTerminal: mock(() => undefined),
    terminalMessage: mock(() => undefined),
    terminalDrain: mock(() => undefined),
    terminalPong: mock(() => undefined),
    terminalClose,
  } as unknown as PdmuxGateway;
  return { gateway, agentClose, terminalClose };
}

describe("PDMUX WebSocket transport", () => {
  it("[TC-PDAGENT-059] uses the stable Bun socket across agent lifecycle callbacks", async () => {
    const openAgent = mock(async (socket: unknown, _context: unknown) => pingSocket(socket));
    const agentMessage = mock((_socket: unknown, _message: unknown) => undefined);
    const agentPong = mock((_socket: unknown) => undefined);
    const agentClose = mock((_socket: unknown) => undefined);
    const gateway = {
      authorizeAgent: mock(async () => ({
        hostId: "host-1",
        organizationId: "org-1",
        tokenId: "token-1",
        tokenExpiresAt: null,
        verify: false,
      })),
      openAgent,
      agentMessage,
      agentPong,
      agentClose,
      authorizeTerminal: mock(async () => {
        throw new Error("unexpected terminal authorization");
      }),
    } as unknown as PdmuxGateway;
    const app = new Elysia()
      .use(createPdmuxWsPlugin(gateway)(context(new Shutdown())))
      .listen({ hostname: "127.0.0.1", port: 0 });
    const port = app.server?.port;
    if (port === undefined) throw new Error("WebSocket test server did not start");
    const socket = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ type: "hello", version: "0.1.23" }));
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => reject(new Error("Agent WebSocket failed to open")), {
          once: true,
        });
      });
      await waitFor(() => agentMessage.mock.calls.length === 1);
      await waitFor(() => agentPong.mock.calls.length === 1);
      socket.close();
      await waitFor(() => agentClose.mock.calls.length === 1);

      expect(openAgent).toHaveBeenCalledTimes(1);
      expect(agentMessage.mock.calls[0]?.[0]).toBe(openAgent.mock.calls[0]?.[0]);
      expect(agentPong.mock.calls[0]?.[0]).toBe(openAgent.mock.calls[0]?.[0]);
      expect(agentClose.mock.calls[0]?.[0]).toBe(openAgent.mock.calls[0]?.[0]);
      expect(agentMessage.mock.calls[0]?.[1]).toEqual({ type: "hello", version: "0.1.23" });
    } finally {
      socket.close();
      await app.stop(true);
    }
  });

  it("[TC-PDTERM-057] uses the stable Bun socket across terminal lifecycle callbacks", async () => {
    const openTerminal = mock((socket: unknown, _context: unknown) => pingSocket(socket));
    const terminalMessage = mock((_socket: unknown, _message: unknown) => undefined);
    const terminalPong = mock((_socket: unknown) => undefined);
    const terminalClose = mock((_socket: unknown, _code: number, _reason: string) => undefined);
    const gateway = {
      authorizeAgent: mock(async () => {
        throw new Error("unexpected agent authorization");
      }),
      authorizeTerminal: mock(async () => ({
        hostId: "host-1",
        hostLabel: "Host",
        principal: {
          userId: "user-1",
          userName: "User",
          userEmail: "user@example.com",
          scopeId: "personal:user-1",
        },
        bufferBytes: 1_024,
      })),
      openTerminal,
      terminalMessage,
      terminalDrain: mock(() => undefined),
      terminalPong,
      terminalClose,
    } as unknown as PdmuxGateway;
    const app = new Elysia()
      .use(createPdmuxWsPlugin(gateway)(context(new Shutdown())))
      .listen({ hostname: "127.0.0.1", port: 0 });
    const port = app.server?.port;
    if (port === undefined) throw new Error("WebSocket test server did not start");
    const socket = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?hostId=host-1`);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ type: "resize", paneId: "pane-1", cols: 120, rows: 40 }));
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => reject(new Error("Terminal WebSocket failed to open")), {
          once: true,
        });
      });
      await waitFor(() => terminalMessage.mock.calls.length === 1);
      await waitFor(() => terminalPong.mock.calls.length === 1);
      socket.close();
      await waitFor(() => terminalClose.mock.calls.length === 1);

      expect(openTerminal).toHaveBeenCalledTimes(1);
      expect(terminalMessage.mock.calls[0]?.[0]).toBe(openTerminal.mock.calls[0]?.[0]);
      expect(terminalPong.mock.calls[0]?.[0]).toBe(openTerminal.mock.calls[0]?.[0]);
      expect(terminalClose.mock.calls[0]?.[0]).toBe(openTerminal.mock.calls[0]?.[0]);
      expect(terminalMessage.mock.calls[0]?.[1]).toEqual({
        type: "resize",
        paneId: "pane-1",
        cols: 120,
        rows: 40,
      });
    } finally {
      socket.close();
      await app.stop(true);
    }
  });

  it("[TC-PDHOST-033] refuses an upgrade during a database outage with 503 and its code", async () => {
    const outage = mock(async (): Promise<never> => {
      throw databaseUnavailable();
    });
    const gateway = { authorizeAgent: outage, authorizeTerminal: outage } as unknown as PdmuxGateway;
    const app = new Elysia().use(createPdmuxWsPlugin(gateway)(context(new Shutdown())));
    const upgrade = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    };

    for (const path of [AGENT_WS_PATH, `${TERMINAL_WS_PATH}?hostId=host-1`]) {
      const response = await app.handle(new Request(`http://localhost${path}`, { headers: upgrade }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "DATABASE_UNAVAILABLE" },
      });
    }
    expect(outage).toHaveBeenCalledTimes(2);
  });
});

describe("[TC-PDAGENT-130] a stopping API ends its WebSockets at once", () => {
  it("closes agent and terminal sockets with GOING_AWAY when shutdown starts", async () => {
    const shutdown = new CountingShutdown();
    const { gateway, agentClose, terminalClose } = shutdownGateway();
    const app = new Elysia().use(createPdmuxWsPlugin(gateway)(context(shutdown))).listen({ hostname: "127.0.0.1", port: 0 });
    const port = app.server?.port;
    if (port === undefined) throw new Error("WebSocket test server did not start");
    const agent = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`);
    const terminal = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?hostId=host-1`);
    try {
      await Promise.all([opened(agent), opened(terminal)]);
      await waitFor(() => shutdown.active === 2);
      const codes = Promise.all([closeCode(agent), closeCode(terminal)]);
      const started = Date.now();
      shutdown.begin();
      // The agent and the dashboard read 1001 as an ordinary drop and reconnect.
      expect(await codes).toEqual([GOING_AWAY, GOING_AWAY]);
      expect(Date.now() - started).toBeLessThan(1_000);
      await waitFor(() => agentClose.mock.calls.length === 1 && terminalClose.mock.calls.length === 1);
      expect(shutdown.active).toBe(0);
    } finally {
      agent.close();
      terminal.close();
      await app.stop(true);
    }
  });

  it("forgets a socket that closed before shutdown", async () => {
    const shutdown = new CountingShutdown();
    const { gateway, agentClose, terminalClose } = shutdownGateway();
    const app = new Elysia().use(createPdmuxWsPlugin(gateway)(context(shutdown))).listen({ hostname: "127.0.0.1", port: 0 });
    const port = app.server?.port;
    if (port === undefined) throw new Error("WebSocket test server did not start");
    const agent = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`);
    const terminal = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?hostId=host-1`);
    try {
      await Promise.all([opened(agent), opened(terminal)]);
      await waitFor(() => shutdown.active === 2);
      agent.close();
      terminal.close();
      await waitFor(() => agentClose.mock.calls.length === 1 && terminalClose.mock.calls.length === 1);
      // A listener left behind would grow with every reconnect for the life of the process.
      expect(shutdown.active).toBe(0);
    } finally {
      await app.stop(true);
    }
  });
});
