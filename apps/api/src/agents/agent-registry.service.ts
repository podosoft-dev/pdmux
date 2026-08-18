import { Injectable, Logger } from "@nestjs/common";
import { AGENT_CLOSE_REPLACED, type AgentDownstream, type TerminalServerFrame } from "@pdmux/protocol";

/**
 * Minimal socket surface the registry needs. Depending on this instead of `ws`
 * keeps the relay unit-testable (and would let a future transport — SSE fallback,
 * a test double — register without touching this file).
 */
export interface AgentSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TerminalFrameHandler = (hostId: string, frame: TerminalServerFrame) => void;

/** `replaced` distinguishes "the agent process is gone" from "it reconnected". Both
 *  invalidate live PTY ids, so both must reach the terminal relay. */
export type HostDisconnectHandler = (hostId: string, reason: "closed" | "replaced") => void;
/** Called when an agent attaches, including the reattach after a restart. */
export type HostConnectHandler = (hostId: string) => void;

// The close codes this server sends an agent moved to `@pdmux/protocol`: the agent
// learns why it was dropped from the number alone, which makes them a fact shared
// with another program rather than this file's business. Import them from there.

/**
 * A live agent connection and the credential it was accepted with.
 *
 * WHY THE TOKEN ID IS HERE: authorization is checked once, at the upgrade. When a
 * token is revoked afterwards, "close the socket that credential opened" is a
 * question only this map can answer — the socket itself carries no identity, and a
 * host may hold several valid tokens (a spare for a rebuild, one per operator), so
 * closing by host id would drop an agent that is using a token nobody revoked.
 */
interface AgentConnection {
  socket: AgentSocket;
  tokenId: string;
}

/**
 * Which hosts have an agent attached right now, and the one way to talk to them.
 *
 * IN-MEMORY ON PURPOSE, AND THEREFORE PER-PROCESS: a socket lives in exactly one
 * process, so a registry that pretended to be global would lie. Running more than
 * one API replica needs a pub/sub hop (Redis) in front of `sendToHost` — the
 * single method every caller already goes through, so that change stays local.
 */
@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);
  private readonly connections = new Map<string, AgentConnection>();
  private readonly terminalHandlers = new Set<TerminalFrameHandler>();
  private readonly disconnectHandlers = new Set<HostDisconnectHandler>();
  private readonly connectHandlers = new Set<HostConnectHandler>();

  /**
   * A host has at most one live agent. A second connection wins and the previous
   * socket is closed: after a network partition the old socket can stay "open" on
   * this side for minutes, and keeping it would send terminal input to a peer that
   * is never going to read it.
   *
   * `tokenId` is required rather than optional: it is the connection's identity for
   * every later authorization decision, and an optional one would be forgotten by
   * exactly the caller whose socket most needs dropping.
   */
  register(hostId: string, socket: AgentSocket, tokenId: string): void {
    const existing = this.connections.get(hostId);
    if (existing && existing.socket !== socket) {
      this.logger.log(`Replace agent connection host=${hostId}`);
      this.closeQuietly(existing.socket, AGENT_CLOSE_REPLACED, "replaced by a newer connection", hostId);
      // The new agent process knows nothing about the old one's PTY ids, so open
      // panes are dead even though the host is "connected" again.
      this.emitDisconnect(hostId, "replaced");
    }
    this.connections.set(hostId, { socket, tokenId });
    // AFTER the map is updated and after any replacement disconnect: a subscriber that reopens
    // something must find the new socket, not the one being evicted.
    this.emitConnect(hostId);
  }

  /** Ignores a stale unregister so a slow close cannot evict the newer socket. */
  unregister(hostId: string, socket: AgentSocket): void {
    if (this.connections.get(hostId)?.socket !== socket) return;
    this.connections.delete(hostId);
    this.emitDisconnect(hostId, "closed");
  }

  /**
   * Hang up on one host, because something the upgrade checked stopped being true.
   *
   * WHY IT EVICTS FIRST AND CLOSES SECOND: the entry must not survive a `close()`
   * that throws (a half-open socket that never fires `close` would leave the card
   * "connected" forever), and nothing should be able to write to a connection the
   * server has already decided to end. The agent's own `close` handler then finds
   * the slot empty and its `unregister` is the no-op it should be — one disconnect
   * is emitted, not two.
   *
   * Returns whether there was anything to close, so a caller can log the difference
   * between "dropped it" and "it was already gone".
   */
  closeHost(hostId: string, code: number, reason: string): boolean {
    const existing = this.connections.get(hostId);
    if (!existing) return false;
    this.connections.delete(hostId);
    this.closeQuietly(existing.socket, code, reason, hostId);
    this.emitDisconnect(hostId, "closed");
    return true;
  }

  /**
   * Hang up on the connection(s) a specific credential opened, and nothing else.
   *
   * A linear scan, deliberately: this map is "hosts with an agent attached in this
   * process", a revocation is a rare operator action, and a second index keyed by
   * token would be one more thing to keep in step with `register`/`unregister` for
   * a loop that costs nothing at fleet scale.
   *
   * Returns the hosts it closed — normally zero or one (a token belongs to one
   * host, and a host has one socket), which the caller logs as evidence.
   */
  closeForToken(tokenId: string, code: number, reason: string): string[] {
    const affected = [...this.connections.entries()]
      .filter(([, connection]) => connection.tokenId === tokenId)
      .map(([hostId]) => hostId);
    for (const hostId of affected) this.closeHost(hostId, code, reason);
    return affected;
  }

  /** Which credential a host's live connection was accepted with (null if none). */
  connectedTokenId(hostId: string): string | null {
    return this.connections.get(hostId)?.tokenId ?? null;
  }

  /** ⚠ Never throws: every caller is enforcing a decision that has already been
   *  committed to the database, and a socket that is mid-close must not turn that
   *  completed write into a 500. */
  private closeQuietly(socket: AgentSocket, code: number, reason: string, hostId: string): void {
    try {
      socket.close(code, reason);
    } catch (error) {
      this.logger.warn(`Close agent socket failed host=${hostId}: ${String(error)}`);
    }
  }

  /** Fired when a host's live socket goes away (or is replaced). */
  onHostDisconnect(handler: HostDisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  /**
   * Fired when a host's agent attaches — including the reattach after a restart.
   *
   * ⚠ THE DISCONNECT SIDE WAS NOT ENOUGH, AND THE GAP WAS VISIBLE. A subscriber told that an
   * agent went away could only tear down what depended on it; nothing ever said the agent was
   * back, so a terminal pane stayed dead until the person reloaded the page — even though the
   * multiplexer session on the host had been running the whole time.
   */
  onHostConnect(handler: HostConnectHandler): () => void {
    this.connectHandlers.add(handler);
    return () => this.connectHandlers.delete(handler);
  }

  private emitConnect(hostId: string): void {
    for (const handler of this.connectHandlers) {
      try {
        handler(hostId);
      } catch (error) {
        this.logger.warn(`Connect subscriber failed host=${hostId}: ${String(error)}`);
      }
    }
  }

  private emitDisconnect(hostId: string, reason: "closed" | "replaced"): void {
    for (const handler of this.disconnectHandlers) {
      try {
        handler(hostId, reason);
      } catch (error) {
        this.logger.warn(`Disconnect subscriber failed host=${hostId}: ${String(error)}`);
      }
    }
  }

  isConnected(hostId: string): boolean {
    return this.connections.has(hostId);
  }

  connectedHostIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Returns false when the host has no agent attached — callers surface that as
   *  "host offline" rather than queueing a frame nobody will ever read. */
  sendToHost(hostId: string, frame: AgentDownstream): boolean {
    const connection = this.connections.get(hostId);
    if (!connection) return false;
    try {
      connection.socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.logger.warn(`Send to agent failed host=${hostId}: ${String(error)}`);
      return false;
    }
  }

  /** Terminal output arrives on the agent socket and belongs to a browser socket
   *  the API does not own yet (Track D). Subscribers get it without a hard link. */
  onTerminalFrame(handler: TerminalFrameHandler): () => void {
    this.terminalHandlers.add(handler);
    return () => this.terminalHandlers.delete(handler);
  }

  emitTerminalFrame(hostId: string, frame: TerminalServerFrame): void {
    for (const handler of this.terminalHandlers) {
      try {
        handler(hostId, frame);
      } catch (error) {
        // One broken subscriber must not stop the others (or kill the agent socket).
        this.logger.warn(`Terminal subscriber failed host=${hostId}: ${String(error)}`);
      }
    }
  }
}
