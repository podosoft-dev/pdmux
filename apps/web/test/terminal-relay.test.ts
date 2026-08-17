/**
 * The terminal transport.
 *
 * Everything here is about the failures a terminal must not have: bytes that arrive
 * before anyone is listening (the connect banner), a frame delivered to the wrong
 * pane, a stream that was silently truncated, and — the one that wastes the most
 * time when it happens — a socket that dropped while the pane kept looking alive.
 */
import { describe, expect, it } from "vitest";
import { TerminalRelay, defaultRelayUrl, type RelaySocket } from "$lib/dashboard/terminal-relay";

class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Complete the handshake. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver a server frame. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Lose the connection the way a network does — without warning. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

interface Harness {
  relay: TerminalRelay;
  sockets: FakeSocket[];
  urls: string[];
  run(): void;
  statuses: string[];
}

function harness(): Harness {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const timers: (() => void)[] = [];
  const statuses: string[] = [];
  const relay = new TerminalRelay({
    url: "ws://test/terminal/ws",
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    messages: {
      reconnecting: "relay lost",
      restored: "relay back",
      dropped: (bytes) => `${bytes} bytes lost`,
      failed: (message) => `failed: ${message}`,
    },
    onStatus: (status) => statuses.push(status),
    schedule: (fn) => timers.push(fn),
    cancel: () => undefined,
    random: () => 0.5,
  });
  return {
    relay,
    sockets,
    urls,
    statuses,
    run: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
  };
}

const target = { slotId: "t1", hostId: "h1", kind: "session" as const, session: "main", cols: 80, rows: 24 };

describe("[TC-PDTERM-101] opening a pane", () => {
  it("dials the host's own socket and buffers output that beats the listener", () => {
    const { relay, sockets, urls } = harness();
    const connection = relay.open(target);
    const socket = sockets[0];
    expect(socket).toBeDefined();
    socket?.accept();

    // The server authorises a terminal socket for ONE host at upgrade time, so the
    // host id belongs in the URL — the frames themselves are the protocol's own.
    expect(urls[0]).toBe("ws://test/terminal/ws?hostId=h1");
    const open = socket?.frames().find((frame) => frame.type === "open");
    expect(open).toMatchObject({ type: "open", termId: "t1" });
    expect(open?.target).toMatchObject({ kind: "session", session: "main", cols: 80, rows: 24 });

    socket?.deliver({ type: "output", termId: "t1", data: "banner\r\n", dropped: 0 });
    const chunks: string[] = [];
    connection.onData((chunk) => chunks.push(chunk));
    // Subscribing happens after `open()` returns, so anything earlier has to wait
    // for the listener — otherwise the connect banner is simply gone.
    expect(chunks.join("")).toBe("banner\r\n");
  });
});

describe("[TC-PDTERM-102] multiplexing", () => {
  it("routes output by termId and sends input, resize and close for that pane only", () => {
    const { relay, sockets } = harness();
    const first = relay.open(target);
    const second = relay.open({ ...target, slotId: "t2", session: "other" });
    const socket = sockets[0];
    socket?.accept();

    const firstChunks: string[] = [];
    const secondChunks: string[] = [];
    first.onData((chunk) => firstChunks.push(chunk));
    second.onData((chunk) => secondChunks.push(chunk));

    socket?.deliver({ type: "output", termId: "t2", data: "only-second", dropped: 0 });
    expect(firstChunks).toEqual([]);
    expect(secondChunks).toEqual(["only-second"]);

    first.send("ls\r");
    first.resize(100, 40);
    first.close();
    const types = socket?.frames().map((frame) => `${String(frame.type)}:${String(frame.termId)}`);
    expect(types).toContain("input:t1");
    expect(types).toContain("resize:t1");
    expect(types).toContain("close:t1");
    expect(types).not.toContain("input:t2");
    // One socket carries both panes of a host — re-splitting a grid must not
    // re-handshake, and re-authorising per pane would be the same cost again.
    expect(sockets).toHaveLength(1);
  });

  it("opens a second socket for a pane on another host", () => {
    const { relay, sockets, urls } = harness();
    relay.open(target);
    relay.open({ ...target, slotId: "t3", hostId: "h2" });
    expect(sockets).toHaveLength(2);
    expect(urls).toEqual(["ws://test/terminal/ws?hostId=h1", "ws://test/terminal/ws?hostId=h2"]);
  });

  it("ignores a frame for a pane that is gone and a frame it cannot parse", () => {
    const { relay, sockets } = harness();
    relay.open(target);
    const socket = sockets[0];
    socket?.accept();
    expect(() => socket?.onmessage?.({ data: "not json" })).not.toThrow();
    expect(() => socket?.deliver({ type: "output", termId: "ghost", data: "x", dropped: 0 })).not.toThrow();
  });
});

describe("[TC-PDTERM-103] a truncated stream says so", () => {
  it("writes the dropped byte count into the pane before the data", () => {
    const { relay, sockets } = harness();
    const connection = relay.open(target);
    const socket = sockets[0];
    socket?.accept();
    const chunks: string[] = [];
    connection.onData((chunk) => chunks.push(chunk));

    socket?.deliver({ type: "output", termId: "t1", data: "tail", dropped: 4096 });
    const text = chunks.join("");
    // Silently losing bytes corrupts a build log with no evidence; the pane says it.
    expect(text).toContain("4096 bytes lost");
    expect(text).toContain("tail");
  });
});

describe("[TC-PDTERM-104] reconnection is visible", () => {
  it("tells the pane, backs off, reconnects and re-opens the pane", () => {
    const { relay, sockets, statuses, run } = harness();
    const connection = relay.open(target);
    const first = sockets[0];
    first?.accept();
    const chunks: string[] = [];
    connection.onData((chunk) => chunks.push(chunk));
    first?.deliver({ type: "ready", termId: "t1", pid: 42 });

    first?.drop();
    expect(chunks.join("")).toContain("relay lost");
    expect(statuses).toContain("reconnecting");

    run(); // the scheduled retry
    const second = sockets[1];
    expect(second).toBeDefined();
    second?.accept();
    // The default target is a multiplexer session, so re-opening reattaches to work
    // that kept running while the socket was away.
    expect(second?.frames().filter((frame) => frame.type === "open")).toHaveLength(1);
    expect(chunks.join("")).toContain("relay back");
    expect(statuses).toContain("open");
  });

  it("[TC-PDTERM-104] reconnects at once when the tab comes back, instead of waiting out the backoff", () => {
    /**
     * ⚠ THE BACKOFF IS RIGHT FOR A SERVER THAT IS DOWN AND WRONG FOR A PHONE THAT WAS ASLEEP.
     * This is the round trip the dashboard exists for: give a coding agent an instruction, lock
     * the phone, come back hours later — and a suspended tab freezes the retry timer, so the
     * pane keeps showing the last frame it ever received. That is indistinguishable from a
     * session that died, which is why it was reported as one.
     */
    const { relay, sockets, run } = harness();
    const connection = relay.open(target);
    sockets[0]?.accept();
    const chunks: string[] = [];
    connection.onData((chunk) => chunks.push(chunk));
    sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    sockets[0]?.drop();
    expect(sockets).toHaveLength(1);

    // No timer has fired — this is the state a frozen tab is in.
    relay.wake();
    expect(sockets, "waking the tab did not dial again").toHaveLength(2);
    sockets[1]?.accept();
    // The pane is re-opened, which is what reattaches to the multiplexer session.
    expect(sockets[1]?.frames().filter((frame) => frame.type === "open")).toHaveLength(1);
    expect(chunks.join("")).toContain("relay back");

    // And the frozen retry does not then dial a THIRD socket on top of the live one.
    run();
    expect(sockets, "the pending retry opened a second socket for the same host").toHaveLength(2);
  });

  it("[TC-PDTERM-104] leaves a healthy socket alone when the tab comes back", () => {
    // Waking is safe to ask for on every `visibilitychange`, which fires whenever somebody
    // switches tabs — so the common case has to be free.
    const { relay, sockets } = harness();
    relay.open(target);
    sockets[0]?.accept();
    relay.wake();
    expect(sockets).toHaveLength(1);
  });

  it("[TC-PDTERM-104] does not wake a disposed relay", () => {
    const { relay, sockets } = harness();
    relay.open(target);
    sockets[0]?.accept();
    relay.dispose();
    relay.wake();
    expect(sockets).toHaveLength(1);
  });

  it("stops retrying once disposed", () => {
    const { relay, sockets, run } = harness();
    relay.open(target);
    sockets[0]?.accept();
    relay.dispose();
    run();
    expect(sockets).toHaveLength(1);
    expect(relay.paneCount).toBe(0);
  });
});

describe("[TC-PDTERM-105] the pane learns when its process is gone", () => {
  it("reports the exit code and releases the pane", () => {
    const { relay, sockets } = harness();
    const connection = relay.open(target);
    const socket = sockets[0];
    socket?.accept();
    const codes: (number | null)[] = [];
    connection.onExit((code) => codes.push(code));

    socket?.deliver({ type: "exit", termId: "t1", code: 130 });
    expect(codes).toEqual([130]);
    expect(relay.paneCount).toBe(0);
  });

  it("surfaces a relay error in the pane rather than freezing it", () => {
    const { relay, sockets } = harness();
    const connection = relay.open(target);
    const socket = sockets[0];
    socket?.accept();
    const chunks: string[] = [];
    const codes: (number | null)[] = [];
    connection.onData((chunk) => chunks.push(chunk));
    connection.onExit((code) => codes.push(code));

    socket?.deliver({ type: "error", termId: "t1", message: "host offline" });
    expect(chunks.join("")).toContain("failed: host offline");
    expect(codes).toEqual([null]);
  });
});

describe("[TC-PDTERM-106] same-origin relay URL", () => {
  it("follows the page's scheme so a TLS page never opens a plain socket", () => {
    expect(defaultRelayUrl({ protocol: "https:", host: "pdmux.example" })).toBe("wss://pdmux.example/terminal/ws");
    expect(defaultRelayUrl({ protocol: "http:", host: "localhost:5001" })).toBe("ws://localhost:5001/terminal/ws");
  });
});
