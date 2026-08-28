import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { Elysia } from "elysia";
import type { AppPlugin, ServiceKey } from "../core/services";
import {
  PdmuxGateway,
  type AgentAcceptContext,
  type TerminalAcceptContext,
} from "./pdmux.gateway";

interface UpgradeError extends Error {
  statusCode?: number;
}

type GatewaySocket = Parameters<PdmuxGateway["agentPong"]>[0];
type PongSocket = GatewaySocket | { readonly raw: GatewaySocket };

function pongSocket(socket: PongSocket): GatewaySocket {
  // Elysia 1.4 passes Bun's raw socket to pong at runtime despite typing it as an Elysia wrapper.
  return "raw" in socket ? socket.raw : socket;
}

function rejection(error: unknown): Response {
  const candidate = error as UpgradeError;
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
  return Response.json(
    { success: false, error: { code: "WEBSOCKET_UPGRADE_REJECTED", message: candidate.message } },
    { status },
  );
}

export function createPdmuxWsPlugin(gateway: PdmuxGateway): AppPlugin {
  return () => {
    const agentContexts = new WeakMap<Request, AgentAcceptContext>();
    const terminalContexts = new WeakMap<Request, TerminalAcceptContext>();

    return new Elysia({ name: "pdmux.ws" })
      .ws(AGENT_WS_PATH, {
        beforeHandle: async ({ request }) => {
          try {
            agentContexts.set(request, await gateway.authorizeAgent(request));
          } catch (error) {
            return rejection(error);
          }
          return undefined;
        },
        open: async (ws) => {
          const context = agentContexts.get(ws.data.request);
          if (!context) {
            ws.close(1011, "upgrade context unavailable");
            return;
          }
          agentContexts.delete(ws.data.request);
          await gateway.openAgent(ws.raw, context);
        },
        message: (ws, message) => gateway.agentMessage(ws.raw, message),
        pong: (ws) => gateway.agentPong(pongSocket(ws)),
        close: (ws) => gateway.agentClose(ws.raw),
      })
      .ws(TERMINAL_WS_PATH, {
        beforeHandle: async ({ request }) => {
          try {
            terminalContexts.set(request, await gateway.authorizeTerminal(request));
          } catch (error) {
            return rejection(error);
          }
          return undefined;
        },
        open: (ws) => {
          const context = terminalContexts.get(ws.data.request);
          if (!context) {
            ws.close(1011, "upgrade context unavailable");
            return;
          }
          terminalContexts.delete(ws.data.request);
          gateway.openTerminal(ws.raw, context);
        },
        message: (ws, message) => gateway.terminalMessage(ws.raw, message),
        drain: (ws) => gateway.terminalDrain(ws.raw),
        pong: (ws) => gateway.terminalPong(pongSocket(ws)),
        close: (ws, code, reason) => gateway.terminalClose(ws.raw, code, reason),
      });
  };
}

export const PDMUX_GATEWAY = Symbol("pdmux-gateway") as ServiceKey<PdmuxGateway>;

export const pdmuxWsPlugin: AppPlugin = (context) => {
  return createPdmuxWsPlugin(context.services.resolve(PDMUX_GATEWAY))(context);
};
