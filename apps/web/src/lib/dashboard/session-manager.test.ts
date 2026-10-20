import { describe, expect, it } from "vitest";
import { managedSessions } from "./session-manager";
import type { HostView } from "./types";

describe("[TC-PDUI-237] session management list", () => {
  it("includes unviewed sessions across hosts and separates native and legacy identities", () => {
    const hosts = [
      { id: "one", label: "Build host", enabled: true, online: true, connected: true, sessions: [{ name: "same", backend: "native", sessionId: "uuid", attached: 0 }, { name: "same", attached: 2 }] },
      { id: "two", label: "Offline host", enabled: true, online: false, connected: false, sessions: [{ name: "same", backend: "native", sessionId: "uuid", attached: 0 }] },
    ] as HostView[];
    const rows = managedSessions(hosts);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.key)).size).toBe(3);
    expect(rows[0]).toMatchObject({ attached: 0, online: true, backend: "native", slot: { sessionId: "uuid", session: "same", hostId: "one" } });
    expect(rows[1]).toMatchObject({ attached: 2, backend: "tmux" });
    expect(rows[2]?.online).toBe(false);
    expect(managedSessions(hosts, " BUILD ")).toHaveLength(2);
    expect(managedSessions(hosts, "missing")).toEqual([]);
  });
});
