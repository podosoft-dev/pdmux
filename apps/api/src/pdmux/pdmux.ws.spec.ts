import { describe, expect, it, mock } from "bun:test";
import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { Elysia } from "elysia";
import type { AppContext } from "../core/services";
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

describe("PDMUX WebSocket transport", () => {
  it("[TC-PDAGENT-059] uses the stable Bun socket across agent lifecycle callbacks", async () => {
    const openAgent = mock(async (_socket: unknown, _context: unknown) => undefined);
    const agentMessage = mock((_socket: unknown, _message: unknown) => undefined);
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
      agentPong: mock(() => undefined),
      agentClose,
      authorizeTerminal: mock(async () => {
        throw new Error("unexpected terminal authorization");
      }),
    } as unknown as PdmuxGateway;
    const app = new Elysia()
      .use(createPdmuxWsPlugin(gateway)({} as AppContext))
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
      socket.close();
      await waitFor(() => agentClose.mock.calls.length === 1);

      expect(openAgent).toHaveBeenCalledTimes(1);
      expect(agentMessage.mock.calls[0]?.[0]).toBe(openAgent.mock.calls[0]?.[0]);
      expect(agentClose.mock.calls[0]?.[0]).toBe(openAgent.mock.calls[0]?.[0]);
      expect(agentMessage.mock.calls[0]?.[1]).toEqual({ type: "hello", version: "0.1.23" });
    } finally {
      socket.close();
      await app.stop(true);
    }
  });

  it("[TC-PDTERM-057] uses the stable Bun socket across terminal lifecycle callbacks", async () => {
    const openTerminal = mock((_socket: unknown, _context: unknown) => undefined);
    const terminalMessage = mock((_socket: unknown, _message: unknown) => undefined);
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
      terminalPong: mock(() => undefined),
      terminalClose,
    } as unknown as PdmuxGateway;
    const app = new Elysia()
      .use(createPdmuxWsPlugin(gateway)({} as AppContext))
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
      socket.close();
      await waitFor(() => terminalClose.mock.calls.length === 1);

      expect(openTerminal).toHaveBeenCalledTimes(1);
      expect(terminalMessage.mock.calls[0]?.[0]).toBe(openTerminal.mock.calls[0]?.[0]);
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
});
