import { describe, expect, it } from "bun:test";
import type { MuxSession } from "@pdmux/protocol";
import { SessionRenames, isSessionRenamedEvent, type SessionRenamedEvent } from "./session-renames";

const HOST = "h1";
const renamed = (from: string, to: string, tmuxId = "$0"): SessionRenamedEvent => ({ type: "host.session-renamed", hostId: HOST, tmuxId, from, to });
const tmux = (name: string, tmuxId = "$0"): MuxSession => ({ name, backend: "tmux", tmuxId, attached: 0, windows: 1 });

describe("[TC-PDUI-237] tmux renames made through pdmux are reported on the live session", () => {
  it("lists the names a renamed session had, once the host reports it under the new name", () => {
    const renames = new SessionRenames();
    renames.record(renamed("legacy-one", "legacy-renamed"));
    expect(renames.annotate(HOST, [tmux("legacy-renamed"), tmux("other", "$1")])).toEqual([
      { ...tmux("legacy-renamed"), previousNames: ["legacy-one"] },
      tmux("other", "$1"),
    ]);
    // Renamed again: every earlier name still leads to the current one.
    renames.record(renamed("legacy-renamed", "final"));
    expect(renames.annotate(HOST, [tmux("final")])[0]?.previousNames).toEqual(["legacy-one", "legacy-renamed"]);
  });

  it("keeps the record while the heartbeat before the rename is still the latest", () => {
    const renames = new SessionRenames();
    renames.record(renamed("legacy-one", "legacy-renamed"));
    // Nothing to follow yet, and nothing lost either.
    expect(renames.annotate(HOST, [tmux("legacy-one")])).toEqual([tmux("legacy-one")]);
    expect(renames.annotate(HOST, [tmux("legacy-renamed")])[0]?.previousNames).toEqual(["legacy-one"]);
  });

  it("drops a record once the session ends or carries a name pdmux did not give it, so a reused id inherits nothing", () => {
    const ended = new SessionRenames();
    ended.record(renamed("legacy-one", "legacy-renamed"));
    expect(ended.annotate(HOST, [])).toEqual([]);
    expect(ended.annotate(HOST, [tmux("legacy-renamed")])).toEqual([tmux("legacy-renamed")]);

    const outside = new SessionRenames();
    outside.record(renamed("legacy-one", "legacy-renamed"));
    expect(outside.annotate(HOST, [tmux("w1")])).toEqual([tmux("w1")]);
    expect(outside.annotate(HOST, [tmux("legacy-renamed")])).toEqual([tmux("legacy-renamed")]);
  });

  it("forgets a host's records when its agent reconnects, and keeps hosts apart", () => {
    const renames = new SessionRenames();
    renames.record(renamed("legacy-one", "legacy-renamed"));
    renames.record({ ...renamed("a", "b"), hostId: "h2" });
    renames.forget(HOST);
    expect(renames.annotate(HOST, [tmux("legacy-renamed")])).toEqual([tmux("legacy-renamed")]);
    expect(renames.annotate("h2", [tmux("b")])[0]?.previousNames).toEqual(["a"]);
  });

  it("records a rename once however often it is heard, and never a native session", () => {
    const renames = new SessionRenames();
    renames.record(renamed("legacy-one", "legacy-renamed"));
    renames.record(renamed("legacy-one", "legacy-renamed"));
    expect(renames.annotate(HOST, [tmux("legacy-renamed")])[0]?.previousNames).toEqual(["legacy-one"]);
    const native: MuxSession = { name: "legacy-renamed", backend: "native", sessionId: "11111111-2222-4333-8444-555555555555", attached: 0, windows: 1 };
    expect(renames.annotate(HOST, [native])).toEqual([native]);
  });

  it("accepts only well-formed rename events from the bus", () => {
    expect(isSessionRenamedEvent(renamed("a", "b"))).toBe(true);
    expect(isSessionRenamedEvent({ ...renamed("a", "b"), tmuxId: "main" })).toBe(false);
    expect(isSessionRenamedEvent({ ...renamed("a", "b"), from: "" })).toBe(false);
    expect(isSessionRenamedEvent({ type: "host.changed", hostId: HOST })).toBe(false);
    expect(isSessionRenamedEvent(null)).toBe(false);
  });
});
