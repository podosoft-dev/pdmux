/**
 * The terminal transport.
 *
 * Everything here is about the failures a terminal must not have: bytes that arrive
 * before anyone is listening (the connect banner), a frame delivered to the wrong
 * pane, a stream that was silently truncated, and — the one that wastes the most
 * time when it happens — a socket that dropped while the pane kept looking alive.
 */
import { describe, expect, it } from "vitest";
import { TerminalRelay, bannerStatus, defaultRelayUrl, type RelaySocket } from "$lib/dashboard/terminal-relay";

class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
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

  /** Lose the connection the way a network does — without warning (1006) — or as the server closed it. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
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
  /** Every `[hostId, status]` the relay reported for one host. */
  hostStatuses: [string, string][];
  retryDelays: number[];
}

function harness(): Harness {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const timers: (() => void)[] = [];
  const statuses: string[] = [];
  const hostStatuses: [string, string][] = [];
  const retryDelays: number[] = [];
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
      hostOffline: "host away",
      restored: "relay back",
      dropped: (bytes) => `${bytes} bytes lost`,
      failed: (message) => `failed: ${message}`,
      sessionMissing: "session gone: close and reopen",
    },
    onStatus: (status) => statuses.push(status),
    onHostStatus: (hostId, status) => hostStatuses.push([hostId, status]),
    schedule: (fn, ms) => { if (ms <= 8000) retryDelays.push(ms); return timers.push(fn); },
    cancel: () => undefined,
    random: () => 0.5,
  });
  return {
    relay,
    sockets,
    urls,
    statuses,
    hostStatuses,
    retryDelays,
    run: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
  };
}

const target = { slotId: "t1", hostId: "h1", kind: "session" as const, session: "main", cols: 80, rows: 24 };

describe("[TC-PDTERM-101] opening a pane", () => {
  it("reconnects a native pane by UUID and forwards viewport controls", () => {
    const { relay, sockets, run } = harness();
    const connection = relay.open({ ...target, backend: "native", intent: "create" });
    const first = sockets[0]!;
    first.accept();
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const resolved: string[] = [];
    connection.onSession?.(id => resolved.push(id));
    first.deliver({ type: "ready", termId: "t1", backend: "native", sessionId });
    expect(resolved).toEqual([sessionId]);
    const received: string[] = [];
    const viewports: Array<{ alternate?: boolean; history?: number }> = [];
    connection.onViewport?.(value => viewports.push(value));
    connection.onData(data => received.push(data));
    first.deliver({ type: "screen", termId: "t1", data: "paint", sequence: 1, cols: 40, rows: 12, canvasCols: 120, canvasRows: 40, x: 20, y: 0, follow: false, alternate: true, history: 7 });
    expect(viewports.at(-1)).toMatchObject({ alternate: true, history: 7 });
    expect(received).toEqual(["paint"]);
    connection.send("\x1b[B", "wheel");
    expect(first.frames().at(-1)).toEqual({ type: "input", termId: "t1", data: "\x1b[B", source: "wheel" });
    connection.viewport?.(30, 5, false);
    expect(first.frames().at(-1)).toEqual({ type: "viewport", termId: "t1", x: 30, y: 5, follow: false });
    first.drop(); run();
    const second = sockets[1]!;
    second.accept();
    expect(second.frames().find(frame => frame.type === "open")).toMatchObject({ target: { backend: "native", intent: "attach", sessionId } });
    relay.dispose();
  });
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
  it("keeps backing off until a pane is ready, without claiming a failed handshake restored it", () => {
    const { relay, sockets, run, retryDelays } = harness();
    const pane = relay.open(target);
    const chunks: string[] = [];
    pane.onData(chunk => chunks.push(chunk));
    sockets[0]?.accept(); sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    sockets[0]?.drop();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      run(); sockets[attempt]?.accept();
      expect(relay.status).toBe("reconnecting");
      sockets[attempt]?.drop();
    }
    expect(retryDelays).toEqual([500, 1000, 2000, 4000]);
    expect(chunks.filter(chunk => chunk.includes("relay lost"))).toHaveLength(1);
    expect(chunks.filter(chunk => chunk.includes("relay back"))).toHaveLength(0);
    run(); sockets[4]?.accept(); sockets[4]?.deliver({ type: "ready", termId: "t1", pid: 43 });
    expect(relay.status).toBe("open");
    expect(relay.paneCount).toBe(1);
    expect(chunks.filter(chunk => chunk.includes("relay back"))).toHaveLength(1);
    sockets[4]?.drop();
    expect(retryDelays.at(-1)).toBe(500);
    relay.dispose();
  });

  it("replaces a socket that never completes its handshake", () => {
    const { relay, sockets, run } = harness();
    relay.open(target);
    run(); // connect deadline
    run(); // retry
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toBe(true);
    sockets[1]?.accept(); sockets[1]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    expect(relay.status).toBe("open");
    relay.dispose();
  });

  it("retries a socket constructor failure without losing its pane", () => {
    let attempts = 0;
    const timers: Array<() => void> = [];
    const socket = new FakeSocket();
    const relay = new TerminalRelay({ createSocket: () => { if (attempts++ === 0) throw new Error("Network unavailable"); return socket; }, schedule: fn => timers.push(fn), cancel: () => undefined });
    expect(() => relay.open(target)).not.toThrow();
    timers.shift()?.();
    socket.accept(); socket.deliver({ type: "ready", termId: "t1", pid: 42 });
    expect(relay.paneCount).toBe(1);
    expect(relay.status).toBe("open");
    relay.dispose();
  });

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
    second?.deliver({ type: "ready", termId: "t1", pid: 43 });
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
    sockets[1]?.deliver({ type: "ready", termId: "t1", pid: 43 });
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

  it("does not reconnect a pane the user closed while the server was away", () => {
    const { relay, sockets, run } = harness();
    const pane = relay.open(target);
    sockets[0]?.accept(); sockets[0]?.drop();
    pane.close(); run(); run();
    expect(relay.paneCount).toBe(0);
    expect(sockets).toHaveLength(1);
    relay.dispose();
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
    socket?.drop();
    relay.wake();
    expect(sockets).toHaveLength(1);
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

describe("[TC-PDVM-021] each host's panes show that host's connection", () => {
  it("reports a retrying host without dragging a healthy host's panes along", () => {
    const { relay, sockets, statuses } = harness();
    relay.open(target);
    relay.open({ ...target, slotId: "t2", hostId: "h2" });
    sockets[0]?.accept();
    sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 1 });
    sockets[1]?.accept();
    sockets[1]?.deliver({ type: "ready", termId: "t2", pid: 2 });
    expect(relay.statusOf("h1")).toBe("open");
    expect(relay.statusOf("h2")).toBe("open");

    sockets[1]?.drop();

    // The banner is still the worst host — that is what the toolbar should say…
    expect(statuses.at(-1)).toBe("reconnecting");
    // …but only the host that dropped says so on its own panes.
    expect(relay.statusOf("h1")).toBe("open");
    expect(relay.statusOf("h2")).toBe("reconnecting");
  });

  it("tells the page each time one host's state changes, and closes them all on dispose", () => {
    const { relay, sockets, hostStatuses } = harness();
    relay.open(target);
    sockets[0]?.accept();
    sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 1 });
    sockets[0]?.drop();
    relay.dispose();

    expect(hostStatuses).toEqual([
      ["h1", "connecting"],
      ["h1", "open"],
      ["h1", "reconnecting"],
      ["h1", "closed"],
    ]);
    expect(relay.statusOf("h1")).toBe("closed");
  });

  it("dials a host that came back at once instead of waiting out the backoff its absence grew", () => {
    const { relay, sockets } = harness();
    relay.open(target);
    sockets[0]?.accept();
    sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 1 });
    relay.noteReachable(["h1"]);
    sockets[0]?.drop();
    relay.noteReachable([]);
    expect(sockets, "an unreachable host is not dialled early").toHaveLength(1);

    relay.noteReachable(["h1"]);

    expect(sockets, "the returning host was not dialled").toHaveLength(2);
  });

  it("leaves the backoff alone when a poll only repeats that the host is reachable", () => {
    const { relay, sockets } = harness();
    relay.open(target);
    sockets[0]?.accept();
    sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 1 });
    relay.noteReachable(["h1"]);
    sockets[0]?.drop();

    // The server is the one refusing (an agent restart behind a healthy card): no transition.
    relay.noteReachable(["h1"]);
    relay.noteReachable(["h1"]);

    expect(sockets).toHaveLength(1);
  });
});

describe("[TC-PDVM-021] the toolbar warns only about hosts that should answer", () => {
  it("ignores a sleeping or offline host's retries and still reports a reachable host's", () => {
    const statuses = { asleep: "reconnecting", healthy: "open" } as const;
    // Before: the sleeping machine's retries held the whole toolbar on "reconnecting".
    expect(bannerStatus(statuses, new Set(["healthy"]))).toBe("open");
    expect(bannerStatus(statuses, new Set(["healthy", "asleep"]))).toBe("reconnecting");
    expect(bannerStatus({ a: "connecting", b: "open" }, new Set(["a", "b"]))).toBe("connecting");
    expect(bannerStatus({ asleep: "reconnecting" }, new Set())).toBe("idle");
  });
});

/** How many chunks written into a pane carry `text`. */
function count(chunks: string[], text: string): number {
  return chunks.filter((chunk) => chunk.includes(text)).length;
}

/** The close the API relay sends when the pane's host has no connected agent. */
const HOST_OFFLINE = 4001;

describe("[TC-PDTERM-153] a pane on an offline host says so once", () => {
  it("tells a pane that never attached, once, however many retries the outage takes", () => {
    const { relay, sockets, run } = harness();
    const pane = relay.open(target);
    const chunks: string[] = [];
    pane.onData((chunk) => chunks.push(chunk));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) run();
      sockets[attempt]?.accept();
      sockets[attempt]?.drop(HOST_OFFLINE);
      expect(relay.status).not.toBe("reconnecting");
    }
    // An API restart in the middle of the outage is still the same episode.
    run(); sockets[4]?.accept(); sockets[4]?.drop();
    run(); sockets[5]?.accept(); sockets[5]?.drop(HOST_OFFLINE);
    expect(sockets).toHaveLength(6);
    expect(count(chunks, "host away")).toBe(1);
    expect(count(chunks, "relay lost")).toBe(0);
    relay.dispose();
  });

  it("tells an attached pane its host went offline instead of blaming the relay", () => {
    const { relay, sockets, run } = harness();
    const pane = relay.open(target);
    const chunks: string[] = [];
    pane.onData((chunk) => chunks.push(chunk));
    sockets[0]?.accept(); sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    sockets[0]?.drop(HOST_OFFLINE);
    run(); sockets[1]?.accept(); sockets[1]?.drop(HOST_OFFLINE);
    expect(count(chunks, "host away")).toBe(1);
    expect(count(chunks, "relay lost")).toBe(0);
    expect(relay.status).not.toBe("reconnecting");
    relay.dispose();
  });

  it("keeps an offline host out of the relay status, so healthy panes do not read as reconnecting", () => {
    const { relay, sockets, run, statuses } = harness();
    relay.open(target);
    relay.open({ ...target, slotId: "t2", hostId: "h2" });
    sockets[0]?.accept(); sockets[0]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    sockets[1]?.accept(); sockets[1]?.drop(HOST_OFFLINE);
    expect(relay.status).toBe("open");
    run(); sockets[2]?.accept(); sockets[2]?.drop(HOST_OFFLINE);
    expect(relay.status).toBe("open");
    expect(statuses).not.toContain("reconnecting");
    // A relay outage during the host's outage is still the relay's, and says so.
    sockets[0]?.drop();
    expect(relay.status).toBe("reconnecting");
    relay.dispose();
  });

  it("says the pane is back when the agent returns, even if it had never attached", () => {
    const { relay, sockets, run, retryDelays } = harness();
    const pane = relay.open(target);
    const chunks: string[] = [];
    pane.onData((chunk) => chunks.push(chunk));
    sockets[0]?.accept(); sockets[0]?.drop(HOST_OFFLINE);
    run(); sockets[1]?.accept(); sockets[1]?.drop(HOST_OFFLINE);
    run(); sockets[2]?.accept(); sockets[2]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    expect(relay.status).toBe("open");
    expect(count(chunks, "relay back")).toBe(1);
    expect(chunks.findIndex((chunk) => chunk.includes("host away")))
      .toBeLessThan(chunks.findIndex((chunk) => chunk.includes("relay back")));
    // The next outage is a new episode, and it gets its own notice.
    sockets[2]?.drop(HOST_OFFLINE);
    expect(count(chunks, "host away")).toBe(2);
    expect(retryDelays.at(-1)).toBe(500);
    relay.dispose();
  });

  it("keeps the relay notice for every other close", () => {
    const { relay, sockets, run } = harness();
    const pane = relay.open(target);
    const chunks: string[] = [];
    pane.onData((chunk) => chunks.push(chunk));
    sockets[0]?.accept(); sockets[0]?.drop(1011);
    // A pane that never attached learns nothing from a relay that is down…
    expect(chunks).toEqual([]);
    run(); sockets[1]?.accept(); sockets[1]?.deliver({ type: "ready", termId: "t1", pid: 42 });
    expect(chunks).toEqual([]);
    // …and an attached one still hears that the relay went away.
    sockets[1]?.drop(1001);
    expect(count(chunks, "relay lost")).toBe(1);
    expect(count(chunks, "host away")).toBe(0);
    relay.dispose();
  });
});

describe("[TC-PDTERM-106] same-origin relay URL", () => {
  it("follows the page's scheme so a TLS page never opens a plain socket", () => {
    expect(defaultRelayUrl({ protocol: "https:", host: "pdmux.example" })).toBe("wss://pdmux.example/terminal/ws");
    expect(defaultRelayUrl({ protocol: "http:", host: "localhost:5001" })).toBe("ws://localhost:5001/terminal/ws");
  });
});

it("[TC-PDUI-237] reconnects a renamed tmux session by its acknowledged ID", () => {
  const h = harness();
  h.relay.open({ slotId: "s1", hostId: "h1", kind: "session", session: "old-name", cols: 80, rows: 24 });
  h.sockets[0]!.accept();
  h.sockets[0]!.deliver({ type: "ready", termId: "s1", pid: 42, tmuxId: "$9" });
  h.sockets[0]!.drop(); h.run(); h.sockets[1]!.accept();
  // The name travels with the id so the host can tell a reused `$9` from this session.
  expect(h.sockets[1]!.frames().find(frame => frame.type === "open")).toMatchObject({ target: { backend: "tmux", tmuxId: "$9", session: "old-name" } });
  h.relay.dispose();
});

describe("a saved pane across a host restart", () => {
  const sessionId = "d5ac0000-0000-4000-8000-000000000001";

  it("[TC-PDTERM-168] a saved tmux pane opens with its id and its name", () => {
    const h = harness();
    h.relay.open({ slotId: "s12", hostId: "h1", kind: "session", backend: "tmux", tmuxId: "$0", session: "claude-1", cols: 80, rows: 24 });
    h.sockets[0]!.accept();
    expect(h.sockets[0]!.frames().find(frame => frame.type === "open")).toMatchObject({ target: { backend: "tmux", tmuxId: "$0", session: "claude-1" } });
    h.relay.dispose();
  });

  it("[TC-PDTERM-169] a pane the host reopened as native is announced and reconnects to the native UUID", () => {
    const h = harness();
    const connection = h.relay.open({ slotId: "s12", hostId: "h1", kind: "session", backend: "tmux", tmuxId: "$0", session: "claude-1", cols: 80, rows: 24 });
    const sessions: string[] = [];
    const restored: string[] = [];
    connection.onSession?.((id) => sessions.push(id));
    h.sockets[0]!.accept();
    h.sockets[0]!.deliver({ type: "ready", termId: "s12", pid: 7, backend: "native", sessionId, restored: { reason: "reboot" } });
    connection.onRestored?.((value) => restored.push(value.reason));
    expect(sessions).toEqual([sessionId]);
    // A listener that subscribes after the frame still learns it — the pane mounts late.
    expect(restored).toEqual(["reboot"]);
    h.sockets[0]!.drop(); h.run(); h.sockets[1]!.accept();
    const reopen = h.sockets[1]!.frames().find(frame => frame.type === "open")?.target as Record<string, unknown>;
    expect(reopen).toMatchObject({ backend: "native", sessionId, session: "claude-1", intent: "attach" });
    expect(reopen.tmuxId).toBeUndefined();
    h.relay.dispose();
  });

  it("[TC-PDTERM-170] a saved session the host no longer has says what to do instead of the code", () => {
    const h = harness();
    const connection = h.relay.open({ ...target, slotId: "s14", backend: "native", sessionId, intent: "attach" });
    let written = "";
    connection.onData((chunk) => { written += chunk; });
    h.sockets[0]!.accept();
    h.sockets[0]!.deliver({ type: "error", termId: "s14", message: "SESSION_NOT_FOUND" });
    expect(written).toContain("session gone: close and reopen");
    expect(written).not.toContain("SESSION_NOT_FOUND");
    h.relay.dispose();
  });
});
