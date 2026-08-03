import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { TERMINAL_WS_PATH } from "@pdmux/protocol";
import { auth } from "../auth/auth";
import { rejectUpgrade, upgradePath, upgradeQuery } from "../common/ws-upgrade";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import type { ScopedSession } from "../fleet/session-scope";
import { HostsService } from "../hosts/hosts.service";
import { authorizeTerminal } from "./terminal-auth";
import { TerminalRelayService } from "./terminal-relay.service";

/**
 * Browser end of the terminal. Same `noServer` + `upgrade` pattern as the agent
 * gateway (both paths share one HTTP server), but authenticated with the **session
 * cookie**: this socket is opened by a person, not by a machine holding an API key.
 *
 * The gate runs before the upgrade completes, so an unauthorised caller never
 * receives a socket it could send frames on.
 */
@Injectable()
export class TerminalGateway implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TerminalGateway.name);
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly hosts: HostsService,
    private readonly settings: FleetSettingsService,
    private readonly relay: TerminalRelayService,
  ) {}

  onModuleInit(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!server || typeof server.on !== "function") {
      this.logger.warn("No HTTP server available; terminal relay not mounted");
      return;
    }
    this.relay.attach();
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.logger.log(`Terminal relay listening on ${TERMINAL_WS_PATH}`);
  }

  onApplicationShutdown(): void {
    this.relay.detach();
    this.wss?.close();
    this.wss = null;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (upgradePath(req) !== TERMINAL_WS_PATH) return; // not ours
    void this.authorizeAndAccept(req, socket, head);
  }

  private async authorizeAndAccept(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const hostId = upgradeQuery(req).get("hostId");
    let session: ScopedSession | null = null;
    try {
      session = (await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })) as ScopedSession | null;
    } catch (error) {
      // A failed session lookup is not "anonymous" — it is an outage. Say 503 so
      // the browser retries instead of prompting the user to log in again.
      this.logger.warn(`Terminal session lookup failed: ${String(error)}`);
      return rejectUpgrade(socket, 503, "session unavailable");
    }

    const result = await authorizeTerminal({ session, hostId, hosts: this.hosts });
    if (!result.ok) return rejectUpgrade(socket, result.status, result.reason);

    const wss = this.wss;
    if (!wss) return rejectUpgrade(socket, 503, "relay not ready");

    const { terminalBufferBytes } = await this.settings.resolve(result.principal.scopeId);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connectionId = this.relay.openConnection({
        socket: browserSocket(ws),
        hostId: result.host.id,
        hostLabel: result.host.label,
        principal: result.principal,
        bufferBytes: terminalBufferBytes,
      });
      ws.on("message", (data: unknown) => this.onMessage(connectionId, data));
      ws.on("close", () => this.relay.closeConnection(connectionId));
      ws.on("error", (error: Error) => {
        this.logger.warn(`Terminal socket error connection=${connectionId}: ${error.message}`);
        this.relay.closeConnection(connectionId);
      });
    });
  }

  private onMessage(connectionId: string, data: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      this.logger.warn(`Non-JSON terminal frame connection=${connectionId}`);
      return;
    }
    this.relay.handleClientFrame(connectionId, payload);
  }
}

/** Adapt `ws` to the relay's minimal socket surface (keeps the relay ws-free). */
function browserSocket(ws: WebSocket): {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
} {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get bufferedAmount(): number {
      return ws.bufferedAmount;
    },
  };
}
