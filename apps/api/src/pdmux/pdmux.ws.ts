import { DESKTOP } from "../desktop/desktop.module";
import type { DesktopRouter } from "../desktop/desktop-router";
import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { Elysia } from "elysia";
import { AppException } from "../common/app-exception";
import type { AppPlugin, ServiceKey } from "../core/services";
import { GOING_AWAY } from "../core/shutdown";
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
  // A dependency outage keeps its own code, such as DATABASE_UNAVAILABLE.
  const code = error instanceof AppException && error.statusCode === 503
    ? error.code
    : "WEBSOCKET_UPGRADE_REJECTED";
  return Response.json({ success: false, error: { code, message: candidate.message } }, { status });
}

interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

export function createPdmuxWsPlugin(gateway: PdmuxGateway, desktop?: DesktopRouter): AppPlugin {
  return ({ shutdown }) => {
    const agentContexts = new WeakMap<Request, AgentAcceptContext>();
    const routedTerminals = new WeakMap<Request, NonNullable<Awaited<ReturnType<DesktopRouter["terminalBinding"]>>>>();
    const routedSockets = new WeakSet<object>();
    const terminalContexts = new WeakMap<Request, TerminalAcceptContext>();
    // A socket never ends on its own, so a stopping API would hold it until the
    // shutdown timeout. Each one closes with GOING_AWAY when shutdown starts, and the
    // agent, the dashboard and the desktop reconnect to the next instance.
    const departures = new WeakMap<object, () => void>();
    const closeOnShutdown = (socket: ClosableSocket): void => {
      departures.set(socket, shutdown.onShutdown(() => socket.close(GOING_AWAY, "Server shutting down")));
    };
    const closed = (socket: object): void => {
      departures.get(socket)?.();
      departures.delete(socket);
    };

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
          closeOnShutdown(ws.raw);
          await gateway.openAgent(ws.raw, context);
        },
        message: (ws, message) => gateway.agentMessage(ws.raw, message),
        pong: (ws) => gateway.agentPong(pongSocket(ws)),
        close: (ws) => {
          closed(ws.raw);
          gateway.agentClose(ws.raw);
        },
      })
      .ws(TERMINAL_WS_PATH, {
        beforeHandle: async ({ request }) => {
          try {
            const context = await gateway.authorizeTerminal(request);
            const target = await desktop?.terminalBinding(request);
            if (target) routedTerminals.set(request, target);
            else terminalContexts.set(request, context);
          } catch (error) {
            return rejection(error);
          }
          return undefined;
        },
        open: (ws) => {
          const target = routedTerminals.get(ws.data.request);
          if (target && desktop) {
            routedTerminals.delete(ws.data.request);
            routedSockets.add(ws.raw);
            closeOnShutdown(ws.raw);
            desktop.openTerminal(ws.raw, target);
            return;
          }
          const context = terminalContexts.get(ws.data.request);
          if (!context) {
            ws.close(1011, "upgrade context unavailable");
            return;
          }
          terminalContexts.delete(ws.data.request);
          closeOnShutdown(ws.raw);
          gateway.openTerminal(ws.raw, context);
        },
        message: (ws, message) => { if (!desktop?.terminalMessage(ws.raw, message)) gateway.terminalMessage(ws.raw, message); },
        drain: (ws) => gateway.terminalDrain(ws.raw),
        pong: (ws) => gateway.terminalPong(pongSocket(ws)),
        close: (ws, code, reason) => {
          closed(ws.raw);
          if (routedSockets.has(ws.raw)) { desktop?.closeTerminal(ws.raw); routedSockets.delete(ws.raw); }
          else gateway.terminalClose(ws.raw, code, reason);
        },
      });
  };
}

export const PDMUX_GATEWAY = Symbol("pdmux-gateway") as ServiceKey<PdmuxGateway>;

export const pdmuxWsPlugin: AppPlugin = (context) => {
  return createPdmuxWsPlugin(context.services.resolve(PDMUX_GATEWAY), context.services.tryResolve(DESKTOP))(context);
};
