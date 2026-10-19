import {
  AGENT_KEY_HEADER,
  type AgentDownstream,
  type AgentRefusalReason,
} from "@pdmux/protocol";
import type { AuthSession } from "../auth/auth.service";
import { AppException } from "../common/app-exception";
import { clientAddressOf } from "../core/client-address";
import { ProductLogger } from "../logging/product-logger";
import { SERVER_VERSION } from "../version";
import { isVerifyDial, VerifyDialBudget } from "../agents/agent-verify";
import { authorizeTerminal, type TerminalPrincipal } from "../terminal/terminal-auth";
import type { PdmuxServices } from "./pdmux.services";

interface BunSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(data?: string): unknown;
}

interface AgentConnection {
  hostId: string;
  alive: boolean;
}

export interface AgentAcceptContext {
  hostId: string;
  organizationId: string;
  tokenId: string;
  tokenExpiresAt: string | null;
  verify: boolean;
}

export interface TerminalAcceptContext {
  hostId: string;
  hostLabel: string;
  principal: TerminalPrincipal;
  bufferBytes: number;
}

interface TerminalConnection {
  connectionId: string;
  hostLabel: string;
  alive: boolean;
  openedAt: number;
}

const PING_INTERVAL_MS = 30_000;


function payload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

export class PdmuxGateway {
  private readonly logger = new ProductLogger(PdmuxGateway.name);
  private readonly agentConnections = new Map<BunSocket, AgentConnection>();
  private readonly terminalConnections = new Map<BunSocket, TerminalConnection>();
  private readonly terminalBackpressure = new WeakSet<BunSocket>();
  private readonly verifyBudget = new VerifyDialBudget();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly services: PdmuxServices) {}

  start(): void {
    this.pingTimer ??= setInterval(() => this.sweep(), PING_INTERVAL_MS);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const socket of this.agentConnections.keys()) socket.close(1001, "server shutting down");
    for (const [socket, connection] of this.terminalConnections) {
      this.services.terminalRelay.closeConnection(connection.connectionId);
      socket.close(1001, "server shutting down");
    }
    this.agentConnections.clear();
    this.terminalConnections.clear();
  }

  async authorizeAgent(request: Request): Promise<AgentAcceptContext> {
    // Refused with 503 rather than a 401 the agent would wait out as a revoked
    // token: it retries an ordinary failure on its normal backoff.
    this.services.database.assertReady();
    const presented = request.headers.get(AGENT_KEY_HEADER);
    if (!presented) {
      this.noteRefusal("missing_key", null, request);
      throw Object.assign(new Error("missing agent key"), { statusCode: 401 });
    }
    const outcome = await this.services.agentTokens.resolveOrReason(presented);
    if ("refusal" in outcome) {
      this.noteRefusal(outcome.refusal, outcome.hostId, request);
      throw Object.assign(new Error("invalid agent key"), { statusCode: 401 });
    }
    const host = await this.services.hosts.getById(outcome.hostId, true);
    if (!host) {
      this.noteRefusal("host_deleted", outcome.hostId, request);
      throw Object.assign(new Error("invalid agent key"), { statusCode: 401 });
    }
    if (!host.enabled) {
      this.noteRefusal("host_disabled", host.id, request);
      throw Object.assign(new Error("host disabled"), { statusCode: 403 });
    }
    const verify = isVerifyDial(new URL(request.url).searchParams);
    if (verify && !this.verifyBudget.allow(host.id, Date.now())) {
      throw Object.assign(new Error("too many verify dials"), { statusCode: 429 });
    }
    return {
      hostId: host.id,
      organizationId: host.organizationId,
      tokenId: outcome.token.id,
      tokenExpiresAt: outcome.token.expiresAt?.toISOString() ?? null,
      verify,
    };
  }

  async openAgent(socket: BunSocket, context: AgentAcceptContext): Promise<void> {
    const { hostId, organizationId, tokenId, tokenExpiresAt, verify } = context;
    if (!verify) {
      this.agentConnections.set(socket, { hostId, alive: true });
      this.services.agentRegistry.register(hostId, socket, tokenId);
    }
    try {
      await this.services.agentTokens.markUsed(tokenId);
      const config = await this.services.agentConfig.build(hostId, organizationId);
      this.send(socket, {
        type: "welcome",
		terminalScreenProtocol: 1,
        hostId,
        config,
        serverVersion: SERVER_VERSION,
        ...(tokenExpiresAt === null ? {} : { tokenExpiresAt }),
      });
      if (verify) {
        socket.close(1000, "verify complete");
        return;
      }
      await this.services.agentAck.ackAllRepos(hostId);
    } catch (error) {
      this.logger.error(`Open agent session failed host=${hostId}: ${String(error)}`);
      socket.close(1011, "config unavailable");
    }
  }

  agentMessage(socket: BunSocket, message: unknown): void {
    const connection = this.agentConnections.get(socket);
    if (!connection) return;
    connection.alive = true;
    const parsed = payload(message);
    if (typeof parsed === "string") {
      this.logger.warn(`Non-JSON agent frame host=${connection.hostId}`);
      return;
    }
    // Bun exits on an unhandled rejection, and every frame that is stored fails
    // while PostgreSQL is down. The socket stays open: terminals do not need it.
    void this.services.agentIngest.handle(connection.hostId, parsed)
      .catch((error: unknown) => this.ingestFailed(connection.hostId, error));
  }

  agentPong(socket: BunSocket): void {
    const connection = this.agentConnections.get(socket);
    if (connection) connection.alive = true;
  }

  agentClose(socket: BunSocket): void {
    const connection = this.agentConnections.get(socket);
    if (!connection) return;
    this.agentConnections.delete(socket);
    this.services.agentRegistry.unregister(connection.hostId, socket);
  }

  async authorizeTerminal(request: Request): Promise<TerminalAcceptContext> {
    this.services.database.assertReady();
    let session: AuthSession | null;
    try {
      session = await this.services.auth.session(request);
    } catch (error) {
      this.logger.warn(`Terminal session lookup failed: ${String(error)}`);
      throw Object.assign(new Error("session unavailable"), { statusCode: 503 });
    }
    const result = await authorizeTerminal({
      session,
      hostId: new URL(request.url).searchParams.get("hostId"),
      hosts: this.services.hosts,
    });
    if (!result.ok) throw Object.assign(new Error(result.reason), { statusCode: result.status });
    const { terminalBufferBytes } = await this.services.fleetSettings.resolve(result.principal.scopeId);
    return {
      hostId: result.host.id,
      hostLabel: result.host.label,
      principal: result.principal,
      bufferBytes: terminalBufferBytes,
    };
  }

  openTerminal(socket: BunSocket, context: TerminalAcceptContext): void {
    const thisGateway = this;
    const connectionId = this.services.terminalRelay.openConnection({
      socket: {
        send: (data) => {
          if (socket.send(data) === -1) this.terminalBackpressure.add(socket);
        },
        close: (code, reason) => socket.close(code, reason),
        get bufferedAmount(): number {
          return thisGateway.terminalBackpressure.has(socket) ? Number.MAX_SAFE_INTEGER : 0;
        },
      },
      hostId: context.hostId,
      hostLabel: context.hostLabel,
      principal: context.principal,
      bufferBytes: context.bufferBytes,
    });
    this.terminalConnections.set(socket, {
      connectionId,
      hostLabel: context.hostLabel,
      alive: true,
      openedAt: Date.now(),
    });
    this.logger.log(`Terminal socket open connection=${connectionId} host=${context.hostLabel}`);
  }

  terminalDrain(socket: BunSocket): void {
    this.terminalBackpressure.delete(socket);
  }

  terminalMessage(socket: BunSocket, message: unknown): void {
    const connection = this.terminalConnections.get(socket);
    if (!connection) return;
    const parsed = payload(message);
    if (typeof parsed === "string") {
      this.logger.warn(`Non-JSON terminal frame connection=${connection.connectionId}`);
      return;
    }
    this.services.terminalRelay.handleClientFrame(connection.connectionId, parsed);
  }

  terminalPong(socket: BunSocket): void {
    const connection = this.terminalConnections.get(socket);
    if (connection) connection.alive = true;
  }

  terminalClose(socket: BunSocket, code: number, reason: string): void {
    const connection = this.terminalConnections.get(socket);
    if (!connection) return;
    this.terminalConnections.delete(socket);
    const panes = this.services.terminalRelay.paneCount(connection.connectionId);
    this.services.terminalRelay.closeConnection(connection.connectionId);
    this.logger.log(
      `Terminal socket close connection=${connection.connectionId} host=${connection.hostLabel} ` +
      `code=${code} reason=${reason || "-"} lifetimeMs=${Date.now() - connection.openedAt} panes=${panes}`,
    );
  }

  private sweep(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [socket, connection] of this.agentConnections) {
      if (!connection.alive) {
        socket.terminate();
        this.agentClose(socket);
        continue;
      }
      connection.alive = false;
      this.send(socket, { type: "ping", ts: now });
      try { socket.ping(); } catch { /* collected on the next pass */ }
    }
    for (const [socket, connection] of this.terminalConnections) {
      if (!connection.alive) {
        socket.terminate();
        this.terminalClose(socket, 1006, "ping timeout");
        continue;
      }
      connection.alive = false;
      try { socket.ping(); } catch { /* collected on the next pass */ }
    }
  }

  private ingestFailed(hostId: string, error: unknown): void {
    // Readiness already reports the outage; a line per frame would repeat it.
    if (error instanceof AppException && error.code === "DATABASE_UNAVAILABLE") {
      this.logger.debug(`Drop agent frame host=${hostId}: the database is unavailable`);
      return;
    }
    this.logger.warn(`Store agent frame failed host=${hostId}: ${String(error)}`);
  }

  private noteRefusal(reason: AgentRefusalReason, hostId: string | null, request: Request): void {
    void this.services.agentAuthFailures.record(reason, hostId, clientAddressOf(request.headers) ?? null);
  }

  private send(socket: BunSocket, frame: AgentDownstream): void {
    try { socket.send(JSON.stringify(frame)); } catch (error) {
      this.logger.warn(`Send to agent failed: ${String(error)}`);
    }
  }
}
