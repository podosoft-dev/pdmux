import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AGENT_KEY_HEADER,
  AGENT_WS_PATH,
  type AgentDownstream,
  type AgentRefusalReason,
} from "@pdmux/protocol";
import { clientIp } from "../common/client-ip";
import { rejectUpgrade, upgradePath, upgradeQuery } from "../common/ws-upgrade";
import { SERVER_VERSION } from "../version";
import { HostsService } from "../hosts/hosts.service";
import { AgentAckService } from "./agent-ack.service";
import { AgentAuthFailuresService } from "./agent-auth-failures.service";
import { AgentConfigService } from "./agent-config.service";
import { AgentIngestService } from "./agent-ingest.service";
import { AgentRegistryService } from "./agent-registry.service";
import { AgentTokensService } from "./agent-tokens.service";
import { VerifyDialBudget, isVerifyDial } from "./agent-verify";

/**
 * ⚠ NO `organizationId` HERE. It was, and it was the one thing on this map that
 * outlived the check that produced it: read once at the upgrade and handed to
 * every frame for the life of the socket. `AgentIngestService` now reads the scope
 * from the host row at the moment it needs it, so there is nothing left to go
 * stale. The scope below in `AcceptContext` is a different thing — it is used
 * inside `accept()`, microseconds after the row it came from was read.
 */
interface AgentConnection {
  hostId: string;
  /** Cleared by any frame; a connection that misses two ping rounds is dropped. */
  alive: boolean;
}

/** What an authorised upgrade carries into the accept path. */
export interface AcceptContext {
  hostId: string;
  organizationId: string;
  tokenId: string;
  /** When the token expires, ISO — passed to the agent in `welcome`. Never = null. */
  tokenExpiresAt: string | null;
  /** A candidate binary proving it can connect — see agent-verify.ts. */
  verify: boolean;
}

/** How often the server pokes an idle agent. Long enough not to matter, short
 *  enough that a half-open socket (NAT timeout, laptop lid) is noticed. */
const PING_INTERVAL_MS = 30_000;

/**
 * The agent's only entry point.
 *
 * WHY A RAW `ws` SERVER ON `noServer` INSTEAD OF A NEST GATEWAY: the app also has
 * to serve a browser terminal socket on a different path, and mounting Nest's WS
 * adapter takes over the whole HTTP upgrade. Handling `upgrade` ourselves lets two
 * independent paths coexist — and this handler ignores (rather than rejects) a
 * path that is not ours, so a second listener still gets its chance.
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AgentGateway.name);
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly connections = new Map<WebSocket, AgentConnection>();
  private readonly verifyBudget = new VerifyDialBudget();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tokens: AgentTokensService,
    private readonly hosts: HostsService,
    private readonly config: AgentConfigService,
    private readonly ingest: AgentIngestService,
    private readonly registry: AgentRegistryService,
    private readonly ack: AgentAckService,
    private readonly failures: AgentAuthFailuresService,
  ) {}

  onModuleInit(): void {
    // The sidebar wants "socket attached right now", which only this process knows.
    this.hosts.setConnectedProbe((hostId) => this.registry.isConnected(hostId));

    const server = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!server || typeof server.on !== "function") {
      // Application context (worker, tests): no HTTP server to attach to.
      this.logger.warn("No HTTP server available; agent gateway not mounted");
      return;
    }
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.pingTimer = setInterval(() => this.sweep(), PING_INTERVAL_MS);
    this.logger.log(`Agent gateway listening on ${AGENT_WS_PATH}`);
  }

  onApplicationShutdown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const socket of this.connections.keys()) socket.close(1001, "server shutting down");
    this.connections.clear();
    this.wss?.close();
    this.wss = null;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (upgradePath(req) !== AGENT_WS_PATH) return; // not ours — leave it for another listener
    void this.authorizeAndAccept(req, socket, head);
  }

  /**
   * Every rung of the refusal ladder, recorded.
   *
   * ⚠ THE LADDER'S RESPONSES ARE UNCHANGED BY THIS EXISTING. Recording a reason is
   * the only thing it does. Missing, unknown, revoked and expired all still answer one
   * opaque 401, because a refusal that said which is an oracle: it tells whoever is
   * spraying secrets that a guess was once real, and it tells them the day a real
   * credential lapsed. The distinction goes into the aggregate an administrator
   * reads and nowhere else.
   *
   * ⚠ NOT AWAITED, on purpose. The bookkeeping is a write on the path a machine
   * retries forever, so a slow or unreachable table must not hold up (or fail) a
   * refusal — `record` swallows its own errors for the same reason.
   */
  private noteRefusal(
    reason: AgentRefusalReason,
    hostId: string | null,
    req: IncomingMessage,
  ): void {
    void this.failures.record(reason, hostId, clientIp(req));
  }

  /**
   * The refusal ladder, and the accept behind it.
   *
   * NOT PRIVATE ON PURPOSE, for the reason `accept()` is not: what is worth
   * asserting here is which refusal each rung records and that all of them still
   * answer the same opaque status — and reaching that through a real HTTP upgrade
   * would put a socket, a listener and a port between the spec and the rule.
   */
  async authorizeAndAccept(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const header = req.headers[AGENT_KEY_HEADER];
    const presented = Array.isArray(header) ? header[0] : header;
    if (!presented) {
      this.noteRefusal("missing_key", null, req);
      return rejectUpgrade(socket, 401, "missing agent key");
    }

    // `resolveOrReason` rather than `resolve`: the same single gate, plus the fact
    // that used to be thrown away. `revoked` is the reason an operator most needs
    // to see, and it is exactly the one `resolve` cannot express.
    const outcome = await this.tokens.resolveOrReason(presented);
    if ("refusal" in outcome) {
      // `unknown` names no host because no row was found; the other two do, which is
      // what turns a wall of refusals into "build-01 is still dialling with the
      // token you revoked".
      this.noteRefusal(outcome.refusal, outcome.hostId, req);
      return rejectUpgrade(socket, 401, "invalid agent key");
    }

    const host = await this.hosts.getById(outcome.hostId);
    if (!host) {
      // The token resolved and its host did not: the row was deleted under a live
      // agent, which is the case that otherwise looks identical to a bad key.
      this.noteRefusal("host_deleted", outcome.hostId, req);
      return rejectUpgrade(socket, 401, "invalid agent key");
    }
    // A disabled host is parked on purpose: keep the token valid (so re-enabling
    // needs no reinstall) but refuse the connection.
    if (!host.enabled) {
      this.noteRefusal("host_disabled", host.id, req);
      return rejectUpgrade(socket, 403, "host disabled");
    }

    // The path was matched without the query (`upgradePath` strips it), so the
    // mode is read here rather than at the routing step.
    const verify = isVerifyDial(upgradeQuery(req));
    if (verify && !this.verifyBudget.allow(host.id, Date.now())) {
      this.logger.warn(`Verify dial over budget host=${host.id}`);
      return rejectUpgrade(socket, 429, "too many verify dials");
    }

    const wss = this.wss;
    if (!wss) return rejectUpgrade(socket, 503, "gateway not ready");
    wss.handleUpgrade(req, socket, head, (ws) => {
      void this.accept(ws, {
        hostId: host.id,
        organizationId: host.organizationId,
        tokenId: outcome.token.id,
        tokenExpiresAt: outcome.token.expiresAt ? outcome.token.expiresAt.toISOString() : null,
        verify,
      });
    });
  }

  /**
   * Turn an authorised upgrade into a connection.
   *
   * NOT PRIVATE ON PURPOSE: this is the whole behaviour worth asserting — that a
   * verify dial registers nothing — and reaching it through a real HTTP upgrade
   * would put a socket, a listener and a port between the spec and the rule.
   */
  async accept(ws: WebSocket, context: AcceptContext): Promise<void> {
    const { hostId, organizationId, tokenId, tokenExpiresAt, verify } = context;

    // A socket with no `error` listener makes Node throw, so both modes get one.
    ws.on("error", (error: Error) => {
      this.logger.warn(`Agent socket error host=${hostId}: ${error.message}`);
    });

    if (!verify) {
      this.connections.set(ws, { hostId, alive: true });
      // This is the line a verify dial must not reach: it closes the host's
      // previous socket with code 4000 and kills every PTY open on it.
      //
      // `tokenId` goes with it because authorization is checked here and nowhere
      // else: revoking that credential later has to find THIS socket, and no other
      // one belonging to the same host.
      this.registry.register(hostId, ws, tokenId);
      ws.on("message", (data: unknown) => void this.onMessage(ws, data));
      ws.on("pong", () => {
        const connection = this.connections.get(ws);
        if (connection) connection.alive = true;
      });
      ws.on("close", () => {
        this.connections.delete(ws);
        this.registry.unregister(hostId, ws);
      });
    }

    // ⚠ STAMPED IN BOTH MODES. `lastUsedAt` answers "is this credential still in
    // use", which an operator reads before revoking a token — and the mode is
    // chosen by the caller. Skipping it in verify mode would let anyone holding a
    // stolen key use it indefinitely while the token kept looking dormant. It is
    // one write per dial, and verify dials are rate-limited above. What is NOT
    // written is `hosts.lastSeenAt` (via `applyHello`/ingest): that one means "the
    // agent for this host is here", which a candidate binary is not.
    await this.tokens.markUsed(tokenId);

    try {
      const config = await this.config.build(hostId, organizationId);
      // `tokenExpiresAt` is omitted rather than sent as null when the token never
      // expires: the field is optional in the contract, and absent is what every
      // token minted before expiry existed genuinely means.
      this.send(ws, {
        type: "welcome",
        hostId,
        config,
        serverVersion: SERVER_VERSION,
        ...(tokenExpiresAt === null ? {} : { tokenExpiresAt }),
      });
      if (verify) {
        // The candidate hangs up as soon as it has a welcome; closing from this
        // side means a candidate that does not cannot linger as an unregistered,
        // unswept socket.
        ws.close(1000, "verify complete");
        return;
      }
      // Immediately after welcome: what we already hold. An agent that reconnects
      // with an empty ledger would otherwise burn its first passes re-producing
      // patches we have.
      await this.ack.ackAllRepos(hostId);
    } catch (error) {
      // Without a config the agent cannot collect anything; closing makes it retry
      // (with backoff) rather than sit connected and idle forever. For a verify
      // dial the same close is the honest answer: this server could not complete a
      // handshake, so the candidate must not be committed to.
      this.logger.error(`Build agent config failed host=${hostId}: ${String(error)}`);
      ws.close(1011, "config unavailable");
    }
  }

  private async onMessage(ws: WebSocket, data: unknown): Promise<void> {
    const connection = this.connections.get(ws);
    if (!connection) return;
    connection.alive = true;

    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      this.logger.warn(`Non-JSON agent frame host=${connection.hostId}`);
      return;
    }
    await this.ingest.handle(connection.hostId, payload);
  }

  /** Drops connections that answered neither the protocol ping nor the ws ping. */
  private sweep(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [ws, connection] of this.connections) {
      if (!connection.alive) {
        this.logger.log(`Drop unresponsive agent host=${connection.hostId}`);
        ws.terminate();
        this.connections.delete(ws);
        this.registry.unregister(connection.hostId, ws);
        continue;
      }
      connection.alive = false;
      this.send(ws, { type: "ping", ts: now });
      try {
        ws.ping();
      } catch {
        // A socket that cannot be pinged is collected on the next sweep.
      }
    }
  }

  private send(ws: WebSocket, frame: AgentDownstream): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      this.logger.warn(`Send to agent failed: ${String(error)}`);
    }
  }
}

