/**
 * The browser half of the terminal path.
 *
 * ONE SOCKET PER HOST, MANY PANES PER SOCKET. The server authorises a terminal
 * socket for exactly one host at upgrade time (`/terminal/ws?hostId=…`, session
 * cookie), because a terminal is remote command execution and that gate has to run
 * before any frame can be sent. Within a host, panes multiplex by `termId` — the
 * layout's slot id — so re-splitting a grid from 4-up to 9-up costs no handshakes,
 * which is what a socket per pane would have cost.
 *
 * WHY IT LIVES IN THE APP: `@pdmux/ui` takes a `TerminalAdapter` precisely so that
 * transport stays here. The package must be installable by a project whose terminals
 * come from somewhere else entirely.
 *
 * RECONNECTION IS VISIBLE, NEVER SILENT. A socket that drops while a pane is on
 * screen leaves a terminal that looks alive and swallows every keystroke. Each pane
 * is told, in its own scrollback, that the relay went away and when it came back —
 * and because the default target is a multiplexer session, coming back reattaches to
 * work that kept running.
 */
import { TERMINAL_WS_PATH, parseTerminalServerFrame } from "@pdmux/protocol/terminal";
import type { TerminalAdapter, TerminalConnection, TerminalOpenTarget } from "@pdmux/ui";

/** What the page shows about the relay itself. */
export type RelayStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * The subset of `WebSocket` this class uses.
 *
 * Handlers are properties rather than `addEventListener` so a test double is ten
 * lines instead of an event-target implementation.
 */
export interface RelaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** Notices written into a pane's scrollback. The app owns the wording (i18n). */
export interface RelayMessages {
  reconnecting: string;
  restored: string;
  dropped: (bytes: number) => string;
  failed: (message: string) => string;
}

export interface TerminalRelayOptions {
  /** Base socket URL; the host id is appended as a query parameter per connection. */
  url?: string;
  createSocket?: (url: string) => RelaySocket;
  messages?: Partial<RelayMessages>;
  onStatus?: (status: RelayStatus) => void;
  /** Backoff base/cap in ms. Exposed so a test does not wait seconds. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

const DEFAULT_MESSAGES: RelayMessages = {
  reconnecting: "reconnecting to the relay",
  restored: "reconnected",
  dropped: (bytes) => `${bytes} bytes dropped`,
  failed: (message) => message,
};

const OPEN = 1;

/** ANSI-dimmed, on its own lines, so a notice cannot be mistaken for program output. */
function notice(text: string): string {
  return `\r\n\u001b[2m[pdmux] ${text}\u001b[0m\r\n`;
}

/** Same-origin URL for the relay; the session cookie is what authenticates it. */
export function defaultRelayUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${TERMINAL_WS_PATH}`;
}

interface PaneEntry {
  termId: string;
  hostId: string;
  kind: "session" | "shell";
  session?: string;
  cols: number;
  rows: number;
  data: Set<(chunk: string) => void>;
  exit: Set<(code: number | null) => void>;
  /** Output that arrived before the pane subscribed — see COMPONENTS §3. */
  buffered: string;
  /** True once the relay has confirmed this pane at least once. */
  started: boolean;
  closed: boolean;
}

interface HostConnection {
  hostId: string;
  socket: RelaySocket | null;
  attempts: number;
  retryHandle: unknown;
  hadConnection: boolean;
  panes: Map<string, PaneEntry>;
}

export class TerminalRelay implements TerminalAdapter {
  private readonly url: string;
  private readonly createSocket: (url: string) => RelaySocket;
  private readonly messages: RelayMessages;
  private readonly onStatus: (status: RelayStatus) => void;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  private readonly connections = new Map<string, HostConnection>();
  private disposed = false;

  status: RelayStatus = "idle";

  constructor(options: TerminalRelayOptions = {}) {
    this.url = options.url ?? "";
    this.createSocket =
      options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as RelaySocket);
    this.messages = { ...DEFAULT_MESSAGES, ...(options.messages ?? {}) };
    this.onStatus = options.onStatus ?? ((): void => {});
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.retryMaxMs = options.retryMaxMs ?? 8000;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** How many panes currently hold a connection. Used by the page's status line. */
  get paneCount(): number {
    let total = 0;
    for (const connection of this.connections.values()) total += connection.panes.size;
    return total;
  }

  /** The URL for one host's socket. The host id is authorised at upgrade time. */
  socketUrl(hostId: string): string {
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}hostId=${encodeURIComponent(hostId)}`;
  }

  open(target: TerminalOpenTarget): TerminalConnection {
    // A slot that is re-targeted keeps its id — possibly onto another host — so the
    // old pane is released wherever it lives before the new one is registered.
    this.releaseByTermId(target.slotId);

    const connection = this.connectionFor(target.hostId);
    const entry: PaneEntry = {
      termId: target.slotId,
      hostId: target.hostId,
      kind: target.kind,
      ...(target.session ? { session: target.session } : {}),
      cols: target.cols,
      rows: target.rows,
      data: new Set(),
      exit: new Set(),
      buffered: "",
      started: false,
      closed: false,
    };
    connection.panes.set(entry.termId, entry);
    this.ensureSocket(connection);
    this.sendOpen(connection, entry);

    return {
      send: (data: string): void => {
        if (entry.closed) return;
        this.send(connection, { type: "input", termId: entry.termId, data });
      },
      resize: (cols: number, rows: number): void => {
        if (entry.closed || (cols === entry.cols && rows === entry.rows)) return;
        entry.cols = cols;
        entry.rows = rows;
        this.send(connection, { type: "resize", termId: entry.termId, cols, rows });
      },
      onData: (listener: (data: string) => void): (() => void) => {
        entry.data.add(listener);
        if (entry.buffered) {
          const pending = entry.buffered;
          entry.buffered = "";
          listener(pending);
        }
        return () => entry.data.delete(listener);
      },
      onExit: (listener: (code: number | null) => void): (() => void) => {
        entry.exit.add(listener);
        return () => entry.exit.delete(listener);
      },
      close: (): void => {
        if (entry.closed) return;
        entry.closed = true;
        this.send(connection, { type: "close", termId: entry.termId });
        connection.panes.delete(entry.termId);
        // The socket stays: opening another terminal on this host is the most likely
        // next action, and a live socket makes it instant.
      },
    };
  }

  /**
   * The tab is in front of somebody again — stop waiting out the backoff.
   *
   * ⚠ THE BACKOFF IS RIGHT FOR A SERVER THAT IS DOWN AND WRONG FOR A PHONE THAT WAS ASLEEP.
   * The delay doubles to eight seconds and the timer itself is frozen while the tab is
   * suspended, so a socket that died during the night is reconnected at some point after the
   * screen comes back — and until it does, the pane shows the last frame it ever received,
   * which is indistinguishable from a session that stopped. That is the exact moment this
   * dashboard is used for: give an agent an instruction, put the phone away, come back later
   * and read what happened.
   *
   * Reconnecting is safe to ask for at any time: the default target is a multiplexer session,
   * `onopen` reattaches every live pane, and a connection that is already open or connecting is
   * left alone. Resetting `attempts` matters too — an hours-old failure count would otherwise
   * make the FIRST retry after waking the longest one.
   */
  wake(): void {
    if (this.disposed) return;
    for (const connection of this.connections.values()) {
      if (connection.socket) continue;
      if (connection.retryHandle !== null) {
        this.cancel(connection.retryHandle);
        connection.retryHandle = null;
      }
      connection.attempts = 0;
      this.ensureSocket(connection);
    }
    this.refreshStatus();
  }

  /** Close every socket for good — call it when the page unmounts. */
  dispose(): void {
    this.disposed = true;
    for (const connection of this.connections.values()) {
      if (connection.retryHandle !== null) this.cancel(connection.retryHandle);
      connection.retryHandle = null;
      for (const pane of connection.panes.values()) pane.closed = true;
      connection.panes.clear();
      this.closeSocket(connection);
    }
    this.connections.clear();
    this.setStatus("closed");
  }

  private connectionFor(hostId: string): HostConnection {
    const existing = this.connections.get(hostId);
    if (existing) return existing;
    const created: HostConnection = {
      hostId,
      socket: null,
      attempts: 0,
      retryHandle: null,
      hadConnection: false,
      panes: new Map(),
    };
    this.connections.set(hostId, created);
    return created;
  }

  private releaseByTermId(termId: string): void {
    for (const connection of this.connections.values()) {
      const pane = connection.panes.get(termId);
      if (pane) this.release(connection, pane, null);
    }
  }

  private closeSocket(connection: HostConnection): void {
    const socket = connection.socket;
    connection.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // A socket that is already gone needs no closing.
    }
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  /**
   * One status for a screen that may hold several hosts.
   *
   * A single host that is retrying is what the user needs to know about, so the
   * worst state wins: a green banner while one column silently eats keystrokes is
   * exactly the failure this reports.
   */
  private refreshStatus(): void {
    if (this.disposed) return this.setStatus("closed");
    let anyOpen = false;
    let anyConnecting = false;
    for (const connection of this.connections.values()) {
      if (connection.retryHandle !== null || (connection.hadConnection && !connection.socket)) {
        return this.setStatus("reconnecting");
      }
      if (connection.socket?.readyState === OPEN) anyOpen = true;
      else if (connection.socket) anyConnecting = true;
    }
    if (anyConnecting) return this.setStatus("connecting");
    this.setStatus(anyOpen ? "open" : "idle");
  }

  private ensureSocket(connection: HostConnection): void {
    if (this.disposed || connection.socket) return;
    const socket = this.createSocket(this.socketUrl(connection.hostId));
    connection.socket = socket;
    this.refreshStatus();
    socket.onopen = (): void => {
      connection.attempts = 0;
      connection.hadConnection = true;
      // Re-open every live pane. The default target is a multiplexer session, so
      // this reattaches to work that kept running while the socket was away.
      for (const pane of connection.panes.values()) {
        if (pane.started) this.emit(pane, notice(this.messages.restored));
        this.sendOpen(connection, pane);
      }
      this.refreshStatus();
    };
    socket.onmessage = (event: { data: unknown }): void => this.receive(connection, event.data);
    socket.onclose = (): void => this.dropped(connection);
    socket.onerror = (): void => this.dropped(connection);
  }

  private dropped(connection: HostConnection): void {
    if (this.disposed || !connection.socket) return;
    this.closeSocket(connection);
    for (const pane of connection.panes.values()) {
      if (pane.started) this.emit(pane, notice(this.messages.reconnecting));
    }
    this.retry(connection);
    this.refreshStatus();
  }

  private retry(connection: HostConnection): void {
    if (this.disposed || connection.retryHandle !== null) return;
    // Jitter matters with many tabs open: without it every dashboard in the office
    // retries in the same millisecond after a server restart.
    const base = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** connection.attempts);
    const delay = Math.round(base * (0.7 + this.random() * 0.6));
    connection.attempts += 1;
    connection.retryHandle = this.schedule(() => {
      connection.retryHandle = null;
      this.ensureSocket(connection);
    }, delay);
  }

  private sendOpen(connection: HostConnection, pane: PaneEntry): void {
    this.send(connection, {
      type: "open",
      termId: pane.termId,
      target: {
        kind: pane.kind,
        ...(pane.session ? { session: pane.session } : {}),
        cols: pane.cols,
        rows: pane.rows,
      },
    });
  }

  private send(connection: HostConnection, frame: Record<string, unknown>): void {
    const socket = connection.socket;
    if (!socket || socket.readyState !== OPEN) {
      // Input typed while the relay is away is genuinely lost — the pane has already
      // said so in its scrollback, which is more honest than replaying keystrokes
      // into a shell that may have moved on.
      this.ensureSocket(connection);
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      this.dropped(connection);
    }
  }

  private receive(connection: HostConnection, raw: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return; // A frame we cannot read costs that frame, never the socket.
    }
    const parsed = parseTerminalServerFrame(payload);
    if (!parsed.ok) return;
    const frame = parsed.data;
    const pane = connection.panes.get(frame.termId);
    if (!pane) return;

    switch (frame.type) {
      case "ready":
        pane.started = true;
        break;
      case "output":
        pane.started = true;
        if (frame.dropped > 0) this.emit(pane, notice(this.messages.dropped(frame.dropped)));
        this.emit(pane, frame.data);
        break;
      case "exit":
        this.release(connection, pane, frame.code);
        break;
      case "error":
        this.emit(pane, notice(this.messages.failed(frame.message)));
        this.release(connection, pane, null);
        break;
    }
  }

  private emit(pane: PaneEntry, chunk: string): void {
    if (!pane.data.size) {
      pane.buffered += chunk;
      return;
    }
    for (const listener of pane.data) listener(chunk);
  }

  private release(connection: HostConnection, pane: PaneEntry, code: number | null): void {
    pane.closed = true;
    connection.panes.delete(pane.termId);
    for (const listener of pane.exit) listener(code);
    pane.data.clear();
    pane.exit.clear();
  }
}
