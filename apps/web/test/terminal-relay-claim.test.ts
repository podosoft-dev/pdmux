/**
 * A native pane can take its shared screen back without typing.
 *
 * The host sizes a native session's screen to the viewer that last typed into or resized it.
 * The relay drops a resize whose size has not changed, so a pane focused again in another
 * window — or reattached after the socket dropped, which returns every viewer to the largest
 * size — kept the other window's screen until somebody typed. `claim` resends the pane's size.
 */
import { describe, expect, it } from "vitest";
import { TerminalRelay, type RelaySocket } from "$lib/dashboard/terminal-relay";

const SESSION = "c1a10000-0000-4000-8000-000000000001";

class Socket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  accept(): void { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  resizes(): Array<{ termId: string; cols: number; rows: number }> {
    return this.sent
      .map((line) => JSON.parse(line) as { type: string; termId: string; cols: number; rows: number })
      .filter((frame) => frame.type === "resize")
      .map(({ termId, cols, rows }) => ({ termId, cols, rows }));
  }
}

function relay(): { relay: TerminalRelay; sockets: Socket[] } {
  const sockets: Socket[] = [];
  return {
    sockets,
    relay: new TerminalRelay({
      url: "ws://test/terminal/ws",
      createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
      schedule: () => 0,
      cancel: () => undefined,
    }),
  };
}

describe("[TC-PDTERM-179] claim resends a native pane's size even when it has not changed", () => {
  it("sends the current size on claim, where resize with the same size sends nothing", () => {
    const { relay: subject, sockets } = relay();
    const pane = subject.open({ slotId: "s1", hostId: "h1", kind: "session", session: "w2", backend: "native", sessionId: SESSION, intent: "attach", cols: 120, rows: 40 });
    sockets[0]!.accept();
    sockets[0]!.deliver({ type: "ready", termId: "s1", pid: 1, backend: "native", sessionId: SESSION });

    pane.resize(120, 40);
    expect(sockets[0]!.resizes()).toEqual([]);
    pane.claim?.();
    expect(sockets[0]!.resizes()).toEqual([{ termId: "s1", cols: 120, rows: 40 }]);

    pane.resize(90, 30);
    pane.claim?.();
    expect(sockets[0]!.resizes().slice(1)).toEqual([{ termId: "s1", cols: 90, rows: 30 }, { termId: "s1", cols: 90, rows: 30 }]);
  });

  it("claims for a pane the host turned native, and not before it said so", () => {
    const { relay: subject, sockets } = relay();
    const pane = subject.open({ slotId: "s2", hostId: "h1", kind: "session", session: "main", cols: 80, rows: 24 });
    sockets[0]!.accept();
    pane.claim?.();
    expect(sockets[0]!.resizes()).toEqual([]);
    sockets[0]!.deliver({ type: "ready", termId: "s2", pid: 1, backend: "native", sessionId: SESSION });
    pane.claim?.();
    expect(sockets[0]!.resizes()).toEqual([{ termId: "s2", cols: 80, rows: 24 }]);
  });

  it("sends nothing for a tmux pane or a closed pane", () => {
    const { relay: subject, sockets } = relay();
    const tmux = subject.open({ slotId: "s3", hostId: "h1", kind: "session", session: "main", cols: 80, rows: 24 });
    sockets[0]!.accept();
    sockets[0]!.deliver({ type: "ready", termId: "s3", pid: 1, backend: "tmux", tmuxId: "$1" });
    tmux.claim?.();
    const native = subject.open({ slotId: "s4", hostId: "h1", kind: "session", session: "w2", backend: "native", sessionId: SESSION, intent: "attach", cols: 80, rows: 24 });
    native.close();
    native.claim?.();
    expect(sockets[0]!.resizes()).toEqual([]);
  });
});
