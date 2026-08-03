import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import {
  safeParse,
  terminalClientFrameSchema,
  type TerminalClientFrame,
  type TerminalServerFrame,
} from "@pdmux/protocol";
import { recordAudit } from "../audit/audit-events";
import { AgentRegistryService } from "../agents/agent-registry.service";
import type { TerminalPrincipal } from "./terminal-auth";

/** What the relay needs from a browser socket. Structural so the whole relay is
 *  testable without a network (and so a future transport can plug in). */
export interface BrowserSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Bytes still queued toward the client — the back-pressure signal. */
  readonly bufferedAmount: number;
}

/** Browser-chosen pane id. Kept short because it travels namespaced (see below)
 *  and the protocol caps a termId at 64 characters. */
const CLIENT_TERM_ID = /^[A-Za-z0-9_-]{1,32}$/;

interface Pane {
  clientTermId: string;
  agentTermId: string;
  kind: "session" | "shell";
  session: string | null;
  /** Bytes the RELAY dropped for back-pressure (never mixed into the agent's count). */
  droppedBytes: number;
  openedAt: number;
}

interface Connection {
  id: string;
  hostId: string;
  hostLabel: string;
  principal: TerminalPrincipal;
  socket: BrowserSocket;
  bufferBytes: number;
  panes: Map<string, Pane>;
}

/**
 * Relays terminal frames between a browser socket and the host's agent.
 *
 * NAMESPACING IS THE SECURITY PROPERTY: the browser picks `termId`, so two tabs
 * (or two users) would otherwise be able to name each other's PTYs on the same
 * host. Every id is rewritten to `<connection>:<termId>` before it reaches the
 * agent and rewritten back on the way out, so a pane is addressable only by the
 * socket that opened it — no lookup table to get wrong, the id itself carries the
 * ownership.
 *
 * NOTHING HANGS: every failure (host offline, unknown pane, agent gone) produces
 * a `terminal error` frame first. A browser waiting on a pane that will never
 * answer is the worst outcome here, worse than a hard error.
 */
@Injectable()
export class TerminalRelayService {
  private readonly logger = new Logger(TerminalRelayService.name);
  private readonly connections = new Map<string, Connection>();
  private unsubscribe: (() => void)[] = [];

  constructor(private readonly registry: AgentRegistryService) {}

  /** Wire the agent-side streams. Called once by the gateway at startup. */
  attach(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe.push(
      this.registry.onTerminalFrame((hostId, frame) => this.handleAgentFrame(hostId, frame)),
      this.registry.onHostDisconnect((hostId) => this.handleHostDisconnect(hostId)),
    );
  }

  detach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  /** Register an authorised browser socket. Returns its connection id (the namespace). */
  openConnection(params: {
    socket: BrowserSocket;
    hostId: string;
    hostLabel: string;
    principal: TerminalPrincipal;
    bufferBytes: number;
  }): string {
    // 6 bytes: short enough to keep `<prefix>:<termId>` inside the protocol's
    // 64-char cap, wide enough that concurrent connections do not collide.
    const id = randomBytes(6).toString("hex");
    this.connections.set(id, {
      id,
      hostId: params.hostId,
      hostLabel: params.hostLabel,
      principal: params.principal,
      socket: params.socket,
      bufferBytes: params.bufferBytes,
      panes: new Map(),
    });
    return id;
  }

  /** Frame from the browser. Never throws — a bad frame costs that frame only. */
  handleClientFrame(connectionId: string, raw: unknown): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const parsed = safeParse(terminalClientFrameSchema, raw);
    if (!parsed.ok) {
      this.logger.warn(`Invalid terminal frame connection=${connectionId}: ${parsed.error}`);
      this.send(connection, { type: "error", termId: "", message: `invalid frame: ${parsed.error}` });
      return;
    }
    const frame = parsed.data;
    if (!CLIENT_TERM_ID.test(frame.termId)) {
      this.send(connection, { type: "error", termId: frame.termId, message: "invalid termId" });
      return;
    }

    if (frame.type === "open") {
      this.openPane(connection, frame);
      return;
    }

    const pane = connection.panes.get(frame.termId);
    if (!pane) {
      // Cleanly ends this pane (not the whole socket — other panes on the same
      // connection are healthy and killing them would lose their scrollback).
      this.send(connection, { type: "error", termId: frame.termId, message: "unknown terminal" });
      this.send(connection, { type: "exit", termId: frame.termId, code: null });
      return;
    }

    if (frame.type === "close") {
      this.forward(connection, { ...frame, termId: pane.agentTermId });
      this.closePane(connection, pane, "client");
      return;
    }
    this.forward(connection, { ...frame, termId: pane.agentTermId });
  }

  /** Frame from the agent, addressed by the namespaced id. */
  handleAgentFrame(hostId: string, frame: TerminalServerFrame): void {
    const separator = frame.termId.indexOf(":");
    if (separator <= 0) return; // not one of ours (or a malformed echo)
    const connection = this.connections.get(frame.termId.slice(0, separator));
    const clientTermId = frame.termId.slice(separator + 1);
    // Defence in depth: the namespace already implies the host, but a mismatched
    // frame must never be delivered to a socket authorised for another host.
    if (!connection || connection.hostId !== hostId) return;
    const pane = connection.panes.get(clientTermId);
    if (!pane) return;

    if (frame.type === "output") {
      this.deliverOutput(connection, pane, frame.data, frame.dropped);
      return;
    }
    this.send(connection, { ...frame, termId: clientTermId });
    if (frame.type === "exit") this.closePane(connection, pane, "agent");
  }

  /** Browser socket gone: kill its PTYs on the agent so nothing is left running. */
  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    for (const pane of connection.panes.values()) {
      this.forward(connection, { type: "close", termId: pane.agentTermId });
      void this.audit(connection, pane, "terminal.close", "socket-closed");
    }
    connection.panes.clear();
    this.connections.delete(connectionId);
  }

  /** Agent gone (or replaced): its PTY ids are meaningless now, so end the panes. */
  private handleHostDisconnect(hostId: string): void {
    for (const connection of this.connections.values()) {
      if (connection.hostId !== hostId) continue;
      for (const pane of connection.panes.values()) {
        this.send(connection, { type: "error", termId: pane.clientTermId, message: "agent disconnected" });
        this.send(connection, { type: "exit", termId: pane.clientTermId, code: null });
        void this.audit(connection, pane, "terminal.close", "agent-disconnected");
      }
      connection.panes.clear();
    }
  }

  private openPane(connection: Connection, frame: Extract<TerminalClientFrame, { type: "open" }>): void {
    if (connection.panes.has(frame.termId)) {
      this.send(connection, { type: "error", termId: frame.termId, message: "terminal already open" });
      return;
    }
    const agentTermId = `${connection.id}:${frame.termId}`;
    const forwarded: TerminalClientFrame = { ...frame, termId: agentTermId };
    if (!this.registry.sendToHost(connection.hostId, { type: "terminal", frame: forwarded })) {
      // No agent attached: say so and close, rather than accept keystrokes that
      // go nowhere.
      this.send(connection, { type: "error", termId: frame.termId, message: "host offline" });
      connection.socket.close(4001, "host offline");
      this.connections.delete(connection.id);
      return;
    }
    const pane: Pane = {
      clientTermId: frame.termId,
      agentTermId,
      kind: frame.target.kind,
      session: frame.target.session ?? null,
      droppedBytes: 0,
      openedAt: Date.now(),
    };
    connection.panes.set(frame.termId, pane);
    // Remote command execution — recorded before any byte is typed.
    void this.audit(connection, pane, "terminal.open", "opened");
  }

  private closePane(connection: Connection, pane: Pane, by: "client" | "agent"): void {
    connection.panes.delete(pane.clientTermId);
    void this.audit(connection, pane, "terminal.close", by === "client" ? "closed" : "exited");
  }

  /**
   * Back-pressure. `bufferedAmount` is what the OS/ws layer still owes the client;
   * a build log outruns a slow browser and the queue is the thing that grows until
   * the process dies.
   *
   * The agent's own `dropped` is forwarded UNTOUCHED — it describes what the agent
   * dropped, and rewriting it would destroy the only honest number the pane has.
   * Relay-side drops are reported separately, in a frame the relay originates once
   * the socket drains.
   */
  private deliverOutput(connection: Connection, pane: Pane, data: string, agentDropped: number): void {
    const bytes = Buffer.byteLength(data, "utf8");
    if (connection.socket.bufferedAmount + bytes > connection.bufferBytes) {
      pane.droppedBytes += bytes;
      return;
    }
    if (pane.droppedBytes > 0) {
      this.send(connection, { type: "output", termId: pane.clientTermId, data: "", dropped: pane.droppedBytes });
      pane.droppedBytes = 0;
    }
    this.send(connection, { type: "output", termId: pane.clientTermId, data, dropped: agentDropped });
  }

  private forward(connection: Connection, frame: TerminalClientFrame): void {
    if (!this.registry.sendToHost(connection.hostId, { type: "terminal", frame })) {
      const clientTermId = frame.termId.slice(frame.termId.indexOf(":") + 1);
      this.send(connection, { type: "error", termId: clientTermId, message: "host offline" });
      this.send(connection, { type: "exit", termId: clientTermId, code: null });
      connection.panes.delete(clientTermId);
    }
  }

  private send(connection: Connection, frame: TerminalServerFrame): void {
    try {
      connection.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logger.warn(`Send to browser failed connection=${connection.id}: ${String(error)}`);
    }
  }

  private async audit(connection: Connection, pane: Pane, action: string, outcome: string): Promise<void> {
    await recordAudit({
      action,
      actorId: connection.principal.userId,
      actorName: connection.principal.userName,
      actorEmail: connection.principal.userEmail,
      targetType: "host",
      targetId: connection.hostId,
      targetLabel: connection.hostLabel,
      metadata: {
        termId: pane.clientTermId,
        kind: pane.kind,
        session: pane.session,
        outcome,
        ...(action === "terminal.close" ? { durationMs: Date.now() - pane.openedAt } : {}),
      },
    });
  }

  /** Test/inspection helpers — the relay's state is otherwise invisible. */
  paneCount(connectionId: string): number {
    return this.connections.get(connectionId)?.panes.size ?? 0;
  }

  connectionCount(): number {
    return this.connections.size;
  }
}
