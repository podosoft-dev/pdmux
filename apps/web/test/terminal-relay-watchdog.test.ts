/**
 * The relay notices a socket that stopped answering.
 *
 * A proxy that disappears without closing the TCP connection leaves the browser's socket OPEN and
 * silent: no `close`, no `error`, and every keystroke vanishes. Only the page asking — and the
 * server answering — can tell that apart from a quiet terminal.
 */
import { describe, expect, it } from "vitest";
import { TerminalRelay, type RelayMessages, type RelaySocket } from "$lib/dashboard/terminal-relay";

class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  accept(): void { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  pings(): number { return this.sent.filter((line) => (JSON.parse(line) as { type?: string }).type === "ping").length; }
}

const PING = 1_000;

function harness(messages?: Partial<RelayMessages>) {
  let clock = 0;
  const sockets: FakeSocket[] = [];
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const relay = new TerminalRelay({
    url: "ws://test/terminal/ws",
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    ...(messages ? { messages } : {}),
    now: () => clock,
    pingIntervalMs: PING,
    random: () => 0.5,
    schedule: (fn, ms) => { const id = nextId++; timers.push({ at: clock + ms, fn, id }); return id; },
    cancel: (handle) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
  });
  /** Move the clock, running every timer that falls due on the way, in order. */
  const advance = (ms: number): void => {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      clock = next.at;
      next.fn();
    }
    clock = end;
  };
  return { relay, sockets, advance };
}

const target = { slotId: "t1", hostId: "h1", kind: "session" as const, session: "main", cols: 80, rows: 24 };

describe("[TC-PDWEB-048] an open terminal socket is pinged", () => {
  it("sends an application ping every interval while the socket is open, and none before it opens", () => {
    const { relay, sockets, advance } = harness();
    relay.open(target);
    const socket = sockets[0]!;
    advance(PING * 3);
    expect(socket.pings()).toBe(0);
    socket.accept();
    advance(PING * 3);
    expect(socket.pings()).toBe(3);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: "ping", termId: "" });
    relay.dispose();
  });
});

describe("[TC-PDWEB-049] a socket whose server stopped answering is replaced", () => {
  it("drops a half-open socket once its server has answered a ping and then gone quiet", () => {
    const { relay, sockets, advance } = harness({ reconnecting: "relay lost" });
    const connection = relay.open(target);
    const chunks: string[] = [];
    connection.onData((chunk) => chunks.push(chunk));
    const socket = sockets[0]!;
    socket.accept();
    socket.deliver({ type: "ready", termId: "t1", pid: 1 });
    advance(PING);
    socket.deliver({ type: "pong", termId: "" });
    expect(relay.statusOf("h1")).toBe("open");

    // Nothing more arrives — not a pong, not output. The socket still says OPEN.
    advance(PING * 3);
    expect(socket.closed).toBe(true);
    expect(relay.statusOf("h1")).toBe("reconnecting");
    expect(chunks.join("")).toContain("relay lost");
    advance(PING * 10);
    expect(sockets.length).toBeGreaterThan(1);
    relay.dispose();
  });

  it("counts any frame as life, so a busy pane is not dropped for a late pong", () => {
    const { relay, sockets, advance } = harness();
    relay.open(target);
    const socket = sockets[0]!;
    socket.accept();
    socket.deliver({ type: "pong", termId: "" });
    for (let step = 0; step < 10; step += 1) {
      advance(PING);
      socket.deliver({ type: "output", termId: "t1", data: "x", dropped: 0 });
    }
    expect(socket.closed).toBe(false);
    relay.dispose();
  });

  it("never drops a socket whose server has not answered a single ping (an older server)", () => {
    const { relay, sockets, advance } = harness();
    relay.open(target);
    const socket = sockets[0]!;
    socket.accept();
    advance(PING * 20);
    expect(socket.closed).toBe(false);
    expect(socket.pings()).toBe(20);
    relay.dispose();
  });
});
