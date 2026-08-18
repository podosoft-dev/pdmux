import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { AgentDownstream, TerminalClientFrame, TerminalServerFrame } from "@pdmux/protocol";
import { AgentRegistryService, type AgentSocket } from "../agents/agent-registry.service";
import { setAuditRecorder, type AuditEntry } from "../audit/audit-events";
import { TerminalRelayService, type BrowserSocket } from "./terminal-relay.service";
import type { TerminalPrincipal } from "./terminal-auth";

const HOST = "host-1";
const OTHER_HOST = "host-2";

class FakeAgent implements AgentSocket {
  readonly frames: AgentDownstream[] = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data) as AgentDownstream);
  }
  close(): void {
    /* unused */
  }

  /** Terminal frames this agent was asked to act on. */
  terminalFrames(): TerminalClientFrame[] {
    return this.frames.flatMap((frame) => (frame.type === "terminal" ? [frame.frame] : []));
  }
}

class FakeBrowser implements BrowserSocket {
  readonly frames: TerminalServerFrame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;

  send(data: string): void {
    this.frames.push(JSON.parse(data) as TerminalServerFrame);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  types(): string[] {
    return this.frames.map((frame) => frame.type);
  }
}

const principal = (userId: string): TerminalPrincipal => ({
  userId,
  userName: userId,
  userEmail: `${userId}@example.com`,
  scopeId: "org-a",
});

const openFrame = (termId: string): unknown => ({
  type: "open",
  termId,
  target: { kind: "session", session: "main", cols: 120, rows: 40 },
});

describe("TerminalRelayService", () => {
  let registry: AgentRegistryService;
  let relay: TerminalRelayService;
  let agent: FakeAgent;
  let audits: AuditEntry[];

  beforeEach(() => {
    registry = new AgentRegistryService();
    relay = new TerminalRelayService(registry);
    relay.attach();
    agent = new FakeAgent();
    registry.register(HOST, agent, "token-1");
    audits = [];
    setAuditRecorder(async (entry) => {
      audits.push(entry);
    });
  });

  afterEach(() => {
    relay.detach();
  });

  function connect(browser: FakeBrowser, userId = "user-1", hostId = HOST, bufferBytes = 65_536): string {
    return relay.openConnection({
      socket: browser,
      hostId,
      hostLabel: "build-01",
      principal: principal(userId),
      bufferBytes,
    });
  }

  it("[TC-PDTERM-051] namespaces termIds per browser connection so two tabs cannot address each other", () => {
    const alice = new FakeBrowser();
    const bob = new FakeBrowser();
    const aliceId = connect(alice, "user-1");
    const bobId = connect(bob, "user-2");

    // Both tabs picked the SAME id — the classic collision.
    relay.handleClientFrame(aliceId, openFrame("t1"));
    relay.handleClientFrame(bobId, openFrame("t1"));

    const forwarded = agent.terminalFrames();
    expect(forwarded).toHaveLength(2);
    const [first, second] = forwarded;
    expect(first?.termId).toBe(`${aliceId}:t1`);
    expect(second?.termId).toBe(`${bobId}:t1`);
    expect(first?.termId).not.toBe(second?.termId);
    // Every namespaced id still fits the protocol's 64-char cap.
    for (const frame of forwarded) expect(frame.termId.length).toBeLessThanOrEqual(64);

    // Output for Alice's pane reaches Alice only, under her own id.
    relay.handleAgentFrame(HOST, { type: "output", termId: `${aliceId}:t1`, data: "hello", dropped: 0 });
    expect(alice.frames).toEqual([{ type: "output", termId: "t1", data: "hello", dropped: 0 }]);
    expect(bob.frames).toEqual([]);

    // Bob cannot reach Alice's PTY by guessing her namespaced id either: his frame
    // is rewritten with HIS prefix, so it addresses a pane he owns (or none).
    relay.handleClientFrame(bobId, { type: "input", termId: "t1", data: "whoami\n" });
    expect(agent.terminalFrames().at(-1)?.termId).toBe(`${bobId}:t1`);
  });

  it("[TC-PDTERM-052] relays input, resize and output both ways", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("pane"));

    relay.handleClientFrame(id, { type: "input", termId: "pane", data: "ls\n" });
    relay.handleClientFrame(id, { type: "resize", termId: "pane", cols: 100, rows: 30 });

    const forwarded = agent.terminalFrames();
    expect(forwarded.map((frame) => frame.type)).toEqual(["open", "input", "resize"]);
    expect(forwarded[1]).toMatchObject({ type: "input", data: "ls\n", termId: `${id}:pane` });
    expect(forwarded[2]).toMatchObject({ type: "resize", cols: 100, rows: 30 });

    relay.handleAgentFrame(HOST, { type: "ready", termId: `${id}:pane`, pid: 4242 });
    relay.handleAgentFrame(HOST, { type: "output", termId: `${id}:pane`, data: "file.txt\n", dropped: 0 });
    expect(browser.frames).toEqual([
      { type: "ready", termId: "pane", pid: 4242 },
      { type: "output", termId: "pane", data: "file.txt\n", dropped: 0 },
    ]);
  });

  it("[TC-PDTERM-053] errors instead of hanging: offline host, unknown pane, duplicate open, bad frame", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);

    // Unknown pane — the pane ends cleanly, the socket (and its other panes) live on.
    relay.handleClientFrame(id, { type: "input", termId: "ghost", data: "x" });
    expect(browser.frames).toEqual([
      { type: "error", termId: "ghost", message: "unknown terminal" },
      { type: "exit", termId: "ghost", code: null },
    ]);
    expect(browser.closed).toBeNull();

    // Malformed frame and an out-of-charset termId are answered, never ignored.
    browser.frames.length = 0;
    relay.handleClientFrame(id, { type: "nope" });
    relay.handleClientFrame(id, { type: "input", termId: "../etc", data: "x" });
    expect(browser.types()).toEqual(["error", "error"]);

    // Duplicate open on the same id.
    browser.frames.length = 0;
    relay.handleClientFrame(id, openFrame("dup"));
    relay.handleClientFrame(id, openFrame("dup"));
    expect(browser.frames.at(-1)).toEqual({ type: "error", termId: "dup", message: "terminal already open" });

    // Host offline at open: error + clean close, not a socket that swallows keystrokes.
    const offline = new FakeBrowser();
    const offlineId = connect(offline, "user-1", OTHER_HOST);
    relay.handleClientFrame(offlineId, openFrame("t1"));
    expect(offline.frames).toEqual([{ type: "error", termId: "t1", message: "host offline" }]);
    expect(offline.closed).toEqual({ code: 4001, reason: "host offline" });
    expect(relay.paneCount(offlineId)).toBe(0);
  });

  it("[TC-PDTERM-054] closing the browser socket closes its PTYs on the agent", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("a"));
    relay.handleClientFrame(id, openFrame("b"));
    expect(relay.paneCount(id)).toBe(2);

    relay.closeConnection(id);

    const closes = agent.terminalFrames().filter((frame) => frame.type === "close");
    expect(closes.map((frame) => frame.termId).sort()).toEqual([`${id}:a`, `${id}:b`]);
    expect(relay.connectionCount()).toBe(0);
    // A pane left running on the host after its browser is gone is a leaked shell.
    expect(audits.filter((entry) => entry.action === "terminal.close")).toHaveLength(2);
  });

  it("[TC-PDTERM-054] an agent disconnect holds the panes instead of ending them", () => {
    /**
     * ⚠ THIS USED TO ASSERT `error` + `exit`, AND THAT WAS THE WRONG HALF OF THE TRUTH. The old
     * PTY ids really are dead when an agent goes away — but the default target is a MULTIPLEXER
     * SESSION on the host, which is not. The browser's own socket never dropped either, so
     * nothing on that side re-opened anything and the pane stayed frozen until the person
     * reloaded the page. Reported from a phone, where it looks exactly like a gesture that does
     * nothing.
     */
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("a"));
    browser.frames.length = 0;

    registry.unregister(HOST, agent);

    // Nothing is said and nothing is ended: the session is still running on the host.
    expect(browser.frames).toEqual([]);
    expect(relay.paneCount(id)).toBe(1);
    expect(browser.closed).toBeNull();
  });

  it("[TC-PDTERM-054] refuses input while the agent is away", () => {
    // The id it would be addressed to exists on no host, and a `resize` for it would come back as
    // an error frame that ends the very pane this hold exists to keep.
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("a"));
    registry.unregister(HOST, agent);

    relay.handleClientFrame(id, { type: "input", termId: "a", data: "ls\r" });
    expect(agent.terminalFrames().filter((frame) => frame.type === "input")).toHaveLength(0);
    expect(browser.types()).toEqual([]);
  });

  it("[TC-PDTERM-054] re-opens the waiting panes when an agent attaches again", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("a"));
    browser.frames.length = 0;
    registry.unregister(HOST, agent);

    const returned = new FakeAgent();
    registry.register(HOST, returned, "token-1");

    // The SAME open frame, so the namespaced id and the target are the ones the pane had: a
    // session target reattaches the multiplexer and the work comes back with it.
    const opens = returned.terminalFrames().filter((frame) => frame.type === "open");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.termId).toBe(`${id}:a`);
    expect(relay.paneCount(id)).toBe(1);
    // And the browser is not told anything: from its side the pane simply resumes.
    expect(browser.types()).toEqual([]);

    // Typing works again.
    relay.handleClientFrame(id, { type: "input", termId: "a", data: "ls\r" });
    expect(returned.terminalFrames().filter((frame) => frame.type === "input")).toHaveLength(1);
  });

  it("[TC-PDTERM-054] a replaced agent re-opens them on the new socket", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("a"));
    browser.frames.length = 0;

    // The agent process restarted: its new socket knows nothing about the old PTY ids, which is
    // exactly why the pane has to be opened again rather than ended.
    const replacement = new FakeAgent();
    registry.register(HOST, replacement, "token-1");

    expect(replacement.terminalFrames().filter((frame) => frame.type === "open")).toHaveLength(1);
    expect(relay.paneCount(id)).toBe(1);
    expect(browser.types()).toEqual([]);
  });

  it("[TC-PDTERM-054] gives up when the agent does not come back", async () => {
    /**
     * ⚠ HOLDING FOREVER IS THE OTHER FAILURE, and this file's header names it: a browser waiting
     * on a pane that will never answer is worse than a hard error. Two minutes in production is
     * an agent restart; past that the pane is genuinely gone and says so.
     */
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.setGracePeriod(10);
    relay.handleClientFrame(id, openFrame("a"));
    browser.frames.length = 0;

    registry.unregister(HOST, agent);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(browser.frames).toEqual([
      { type: "error", termId: "a", message: "agent disconnected" },
      { type: "exit", termId: "a", code: null },
    ]);
    expect(relay.paneCount(id)).toBe(0);
    // The socket stays open: another pane can be opened on it the moment a host is there.
    expect(browser.closed).toBeNull();
  });

  it("[TC-PDTERM-055] bounds in-flight output and passes the agent's dropped count through untouched", () => {
    const browser = new FakeBrowser();
    const id = connect(browser, "user-1", HOST, 1000);
    relay.handleClientFrame(id, openFrame("t1"));

    // Agent-reported drops are forwarded verbatim — that number is the agent's.
    relay.handleAgentFrame(HOST, { type: "output", termId: `${id}:t1`, data: "ok", dropped: 77 });
    expect(browser.frames.at(-1)).toEqual({ type: "output", termId: "t1", data: "ok", dropped: 77 });

    // Browser stops reading: the queue is what grows until the process dies.
    browser.bufferedAmount = 990;
    relay.handleAgentFrame(HOST, { type: "output", termId: `${id}:t1`, data: "x".repeat(50), dropped: 0 });
    relay.handleAgentFrame(HOST, { type: "output", termId: `${id}:t1`, data: "y".repeat(30), dropped: 0 });
    expect(browser.frames).toHaveLength(1); // nothing queued while over budget

    // It drains: one relay-originated notice reports what the RELAY dropped, then
    // normal delivery resumes with the agent's own count intact.
    browser.bufferedAmount = 0;
    relay.handleAgentFrame(HOST, { type: "output", termId: `${id}:t1`, data: "z", dropped: 5 });
    expect(browser.frames.slice(1)).toEqual([
      { type: "output", termId: "t1", data: "", dropped: 80 },
      { type: "output", termId: "t1", data: "z", dropped: 5 },
    ]);
  });

  it("[TC-PDTERM-056] records terminal open and close in the audit trail", () => {
    const browser = new FakeBrowser();
    const id = connect(browser, "user-7");
    relay.handleClientFrame(id, openFrame("t1"));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "terminal.open",
      actorId: "user-7",
      actorEmail: "user-7@example.com",
      targetType: "host",
      targetId: HOST,
      targetLabel: "build-01",
      metadata: { termId: "t1", kind: "session", session: "main" },
    });

    relay.handleClientFrame(id, { type: "close", termId: "t1" });
    expect(audits.at(-1)).toMatchObject({ action: "terminal.close", actorId: "user-7", targetId: HOST });
    expect(agent.terminalFrames().at(-1)).toMatchObject({ type: "close", termId: `${id}:t1` });
    expect(relay.paneCount(id)).toBe(0);
  });

  it("[TC-PDTERM-051] drops an agent frame whose host does not match the connection", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("t1"));
    browser.frames.length = 0;

    // Same namespaced id, wrong host — defence in depth behind the namespace.
    relay.handleAgentFrame(OTHER_HOST, { type: "output", termId: `${id}:t1`, data: "leak", dropped: 0 });
    // And an id that belongs to no connection at all.
    relay.handleAgentFrame(HOST, { type: "output", termId: "deadbeef:t1", data: "leak", dropped: 0 });
    relay.handleAgentFrame(HOST, { type: "output", termId: "no-prefix", data: "leak", dropped: 0 });

    expect(browser.frames).toEqual([]);
  });

  it("[TC-PDTERM-053] ends the pane when the agent vanishes mid-session", () => {
    const browser = new FakeBrowser();
    const id = connect(browser);
    relay.handleClientFrame(id, openFrame("t1"));
    browser.frames.length = 0;

    // Socket gone without a close frame (process killed): the next keystroke must
    // not disappear silently.
    relay.detach();
    registry.unregister(HOST, agent);
    relay.handleClientFrame(id, { type: "input", termId: "t1", data: "x" });

    expect(browser.frames).toEqual([
      { type: "error", termId: "t1", message: "host offline" },
      { type: "exit", termId: "t1", code: null },
    ]);
    expect(relay.paneCount(id)).toBe(0);
  });
});
