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
/**
 * How often a browser socket is pinged.
 *
 * ⚠ THIS SOCKET HAD NO KEEPALIVE AT ALL WHILE THE AGENT'S HAD ONE, and the gap
 * was not theoretical. Measured on the live deployment: a terminal socket closed
 * on its own with code 1006 — an abnormal close, no close frame, i.e. an
 * intermediary killed it — after 125 seconds carrying no frames. The path runs
 * through a CDN that drops idle WebSockets at around 100 seconds.
 *
 * A pane that is merely QUIET is the dangerous case, not a pane that is closed:
 * output only flows when the program writes, so a terminal waiting on a coding
 * agent's reply sends nothing for minutes, the socket is reaped, and the next
 * keystroke waits on a reconnect that also has to reattach every pane on that
 * host. From the chair that reads as "the terminal froze", which is how it was
 * reported, repeatedly, with no way to tell it from a slow one.
 *
 * 30s matches AgentGateway rather than being tuned separately: both cross the
 * same network to the same browser-facing edge, and two intervals would be two
 * things to keep in step for no reason.
 */
const PING_INTERVAL_MS = 30_000;

@Injectable()
export class TerminalGateway implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TerminalGateway.name);
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  /** Sockets to keep alive, and whether each answered the last ping. */
  private readonly live = new Map<WebSocket, { connectionId: string; hostLabel: string; alive: boolean }>();

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
    this.pingTimer = setInterval(() => this.sweep(), PING_INTERVAL_MS);
    this.logger.log(`Terminal relay listening on ${TERMINAL_WS_PATH}`);
  }

  onApplicationShutdown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.relay.detach();
    this.live.clear();
    this.wss?.close();
    this.wss = null;
  }

  /**
   * Pings every browser socket and drops the ones that stopped answering.
   *
   * The ping is what keeps a quiet pane's socket from being reaped by the path in
   * front of this server; terminating a socket that missed one is the other half,
   * because a half-open connection accepts writes forever and the panes on it
   * simply stop updating — the failure that looks exactly like slowness.
   */
  private sweep(): void {
    for (const [ws, entry] of this.live) {
      if (!entry.alive) {
        this.logger.log(
          `Drop unresponsive terminal socket connection=${entry.connectionId} host=${entry.hostLabel}`,
        );
        ws.terminate();
        this.live.delete(ws);
        this.relay.closeConnection(entry.connectionId);
        continue;
      }
      entry.alive = false;
      try {
        ws.ping();
      } catch {
        // A socket that cannot be pinged is collected on the next sweep.
      }
    }
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
      // ⚠ THIS SOCKET CARRIES EVERY PANE FOR ONE HOST, so its lifetime is the
      // difference between two bug reports that read identically: "all my terminals
      // on that host went slow at once". If the socket died, the panes died with it
      // and reattached; if it did not, the data path stalled while the socket stayed
      // up. Nothing recorded either, so every round of this started by guessing —
      // and the agent gateway has pinged and swept its sockets for as long as this
      // one has done neither, which makes an idle-timeout drop here entirely
      // plausible and, until now, entirely invisible.
      const openedAt = Date.now();
      this.logger.log(`Terminal socket open connection=${connectionId} host=${result.host.label}`);
      this.live.set(ws, { connectionId, hostLabel: result.host.label, alive: true });
      ws.on("pong", () => {
        const entry = this.live.get(ws);
        if (entry) entry.alive = true;
      });
      ws.on("message", (data: unknown) => this.onMessage(connectionId, data));
      ws.on("close", (code: number, reason: Buffer) => {
        this.live.delete(ws);
        // Counted BEFORE the close, which is what clears the map.
        const panes = this.relay.paneCount(connectionId);
        this.logger.log(
          `Terminal socket close connection=${connectionId} host=${result.host.label} ` +
            `code=${code} reason=${reason.toString() || "-"} lifetimeMs=${Date.now() - openedAt} panes=${panes}`,
        );
        this.relay.closeConnection(connectionId);
      });
      ws.on("error", (error: Error) => {
        this.logger.warn(`Terminal socket error connection=${connectionId}: ${error.message}`);
        // Dropped here as well as on close: an errored socket may never emit
        // `close`, and a stale entry would have the sweep ping a dead handle
        // forever — a keepalive that leaks is worse than none.
        this.live.delete(ws);
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
