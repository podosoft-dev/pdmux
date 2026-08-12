/**
 * The API-to-core mappers.
 *
 * These are the conversions that a component would otherwise do inline, where they
 * could neither be seen nor tested: a date that stays a string draws no graph, a
 * percentage without its byte hint makes a useless tooltip, and a "live" timestamp
 * stamped on a dead collector's numbers is a lie the whole card then tells.
 */
import { describe, expect, it } from "vitest";
import { freshMetrics } from "@pdmux/core";
import {
  formatBytes,
  gridHosts,
  serviceOptionsFor,
  graphCommits,
  hostAddress,
  hostDetails,
  hostResources,
  hostSeries,
  hostState,
  metricsFeed,
  pickerHosts,
  refInputs,
  repoHead,
  serviceUrl,
  uncommittedFor,
  workingDiffFiles,
} from "$lib/dashboard/map";
import type { HostServiceView, HostView, MetricsResponse, RepoRefRow, RepoRow } from "$lib/dashboard/types";

function host(overrides: Partial<HostView> = {}): HostView {
  return {
    id: "h1",
    label: "alpha",
    address: "10.0.0.1",
    agentAddress: null,
    description: null,
    tags: [],
    sortOrder: 0,
    enabled: true,
    agentVersion: "0.1.0",
    latestAgentVersion: "0.1.0",
    agentVersionState: "current",
    lastUpdate: null,
    os: "linux",
    arch: "x64",
    capabilities: [],
    lastSeenAt: "2026-07-25T10:00:00.000Z",
    online: true,
    connected: true,
    resource: null,
    sessions: [],
    usage: [],
    diagnostics: [],
    services: [],
    gitRootCount: 0,
    listeners: [],
    ...overrides,
  };
}

function service(overrides: Partial<HostServiceView> = {}): HostServiceView {
  return {
    id: "s1",
    label: "api",
    port: 3000,
    probe: "tcp",
    path: "/",
    urlTemplate: null,
    sortOrder: 0,
    enabled: true,
    status: "up",
    latencyMs: 3,
    ...overrides,
  };
}

describe("[TC-PDUI-101] host reachability mapping", () => {
  it("calls a disabled host unknown rather than offline", () => {
    // Nobody is collecting a disabled host, so every value is missing by decision.
    // "stopped" would send someone looking for a machine that is fine.
    expect(hostState(host({ enabled: false, online: true }))).toBe("unknown");
    expect(hostState(host({ enabled: true, online: false }))).toBe("offline");
    expect(hostState(host())).toBe("online");
  });

  it("never reports a disabled host as reachable to the terminal grid", () => {
    const [row] = gridHosts([host({ enabled: false, online: true, sessions: [{ name: "main", attached: 0, windows: 1 }] })]);
    expect(row?.online).toBe(false);
    expect(row?.name).toBe("alpha");
    expect(row?.sessions).toHaveLength(1);
  });
});

describe("[TC-PDUI-102] the fast feed carries the newest heartbeat, not the clock", () => {
  it("lets a stale fleet age out instead of looking live", () => {
    const nowMs = Date.parse("2026-07-25T10:10:00.000Z");
    const feed = metricsFeed([host({ lastSeenAt: "2026-07-25T10:00:00.000Z", resource: null })], nowMs);
    expect(feed.ts).toBe(Math.floor(Date.parse("2026-07-25T10:00:00.000Z") / 1000));
    // Ten minutes old is far past the 30s budget, so the rows are ignored.
    expect(freshMetrics(feed, nowMs)).toBeNull();
  });

  it("falls back to the clock when no host has ever been seen", () => {
    const nowMs = 1_700_000_000_000;
    const feed = metricsFeed([host({ lastSeenAt: null })], nowMs);
    expect(feed.ts).toBe(Math.floor(nowMs / 1000));
  });
});

describe("[TC-PDUI-103] metric series", () => {
  const response: MetricsResponse = {
    hostId: "h1",
    t: [100, 130, 160],
    cpu: [10, null, 30],
    mem: [40, 50, 60],
    disk: [70, 70, 70],
    swap: [12, 13, 14],
    step: 30,
    window: 3600,
    latest: null,
  };

  it("turns aligned arrays into per-metric samples and keeps the gap", () => {
    const series = hostSeries(response);
    expect(series.cpu).toEqual([
      { t: 100, v: 10 },
      { t: 130, v: null },
      { t: 160, v: 30 },
    ]);
    expect(series.mem.at(-1)).toEqual({ t: 160, v: 60 });
    expect(series.swap.at(-1)).toEqual({ t: 160, v: 14 });
  });

  it("survives a server that has not deployed the swap column yet", () => {
    // The web app can be newer than the API it is talking to. An absent key must
    // yield an empty series — no line drawn — rather than throwing in a render loop.
    const { swap, ...withoutSwap } = response;
    const series = hostSeries(withoutSwap as MetricsResponse);
    expect(series.swap).toEqual([]);
    expect(series.cpu).toHaveLength(3);
  });
});

describe("[TC-PDUI-104] resources", () => {
  it("formats byte hints a percentage cannot express", () => {
    expect(formatBytes(12 * 1024 ** 3)).toBe("12Gi");
    expect(formatBytes(1536)).toBe("1.5Ki");
    expect(formatBytes(null)).toBe("");
  });

  it("prefers the fresh feed and still hints from the heartbeat's bytes", () => {
    const resources = hostResources(
      host({
        resource: {
          cpuPct: 5,
          memPct: 50,
          diskPct: 66,
          memUsedBytes: 12 * 1024 ** 3,
          memTotalBytes: 30 * 1024 ** 3,
          diskUsedBytes: null,
          diskTotalBytes: null,
          swapPct: 25,
          swapUsedBytes: 2 * 1024 ** 3,
          swapTotalBytes: 8 * 1024 ** 3,
          load1: null,
          uptimeSec: null,
        },
      }),
      { id: "h1", cpuPct: 91, memPct: null, diskPct: null },
    );
    expect(resources.cpuPct).toBe(91);
    // A null in the fresh row means "not measured in that pass": the heartbeat's
    // own value is still the best answer, and it is not zero.
    expect(resources.memPct).toBe(50);
    expect(resources.memHint).toBe("12Gi/30Gi");
    expect(resources.diskHint).toBe("");
    expect(resources.swapPct).toBe(25);
    expect(resources.swapHint).toBe("2.0Gi/8.0Gi");
  });

  it("hints 0B/0B for a swapless host, which is what separates it from an empty one", () => {
    const swapless = hostResources(
      host({
        resource: {
          cpuPct: 5,
          memPct: 50,
          diskPct: 66,
          memUsedBytes: null,
          memTotalBytes: null,
          diskUsedBytes: null,
          diskTotalBytes: null,
          swapPct: 0,
          swapUsedBytes: 0,
          swapTotalBytes: 0,
          load1: null,
          uptimeSec: null,
        },
      }),
      null,
    );
    // Both of these render "0%". Only the hint says which one the machine is.
    expect(swapless.swapPct).toBe(0);
    expect(swapless.swapHint).toBe("0B/0B");
    expect(formatBytes(0)).toBe("0B");
  });
});

describe("[TC-PDUI-105] service links", () => {
  it("uses a registered template verbatim", () => {
    expect(serviceUrl(host(), service({ urlTemplate: "https://api.example.test{path}", path: "/docs" }))).toBe(
      "https://api.example.test/docs",
    );
    expect(serviceUrl(host(), service({ urlTemplate: "http://{address}:{port}/" }))).toBe("http://10.0.0.1:3000/");
  });

  it("builds address:port when there is no template", () => {
    expect(serviceUrl(host(), service({ path: "/health" }))).toBe("http://10.0.0.1:3000/health");
    expect(serviceUrl(host(), service({ port: 443 }))).toBe("https://10.0.0.1:443");
  });

  it("refuses to guess a host that was never registered", () => {
    // Falling back to localhost would open the operator's own machine, which is a
    // different computer than the one on the card.
    expect(serviceUrl(host({ address: null }), service())).toBe("");
  });
});

describe("[TC-PDUI-106] graph rows", () => {
  it("converts ISO timestamps to the epoch seconds the graph draws with", () => {
    const [row] = graphCommits([
      { sha: "abc1234", parents: ["def5678"], refs: ["HEAD -> main"], author: "t", date: "2026-07-25T10:00:00.000Z", subject: "s", hasDetail: true },
      { sha: "def5678", parents: [], refs: [], author: "t", date: null, subject: "root", hasDetail: false },
    ]);
    expect(row?.date).toBe(Math.floor(Date.parse("2026-07-25T10:00:00.000Z") / 1000));
    expect(graphCommits([{ sha: "d", parents: [], refs: [], author: "", date: "not a date", subject: "", hasDetail: false }])[0]?.date).toBeNull();
  });

  it("passes ref tracking state through untouched", () => {
    const [ref] = refInputs([
      { id: "r1", repoId: "p1", name: "main", kind: "local", sha: "abc", upstream: "origin/main", ahead: 2, behind: 0, gone: true },
    ]);
    expect(ref).toEqual({ name: "main", kind: "local", sha: "abc", ahead: 2, behind: 0, gone: true });
  });
});

describe("[TC-PDUI-113] HEAD for the refs panel", () => {
  const row = (overrides: Partial<RepoRow> = {}): RepoRow => ({
    id: "p1",
    hostId: "h1",
    path: "/srv/app",
    name: "app",
    headBranch: "main",
    headSha: "abcdef1234567890",
    detached: false,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    dirtySubmodules: 0,
    truncated: false,
    limit: 300,
    pendingDetails: 0,
    hasWorkingDiff: false,
    lastSnapshotAt: null,
  remoteRefs: null,
  remoteCheckedAt: null,
  remoteError: null,
    error: null,
    ...overrides,
  });
  const ref = (overrides: Partial<RepoRefRow> = {}): RepoRefRow => ({
    id: "r1",
    repoId: "p1",
    name: "main",
    kind: "local",
    sha: "abcdef1234567890",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    gone: false,
    ...overrides,
  });

  it("joins the branch row so the panel knows the upstream by name", () => {
    // The repo row knows the branch and sha; only the ref row knows what it tracks.
    expect(repoHead(row(), [ref()])).toEqual({
      branch: "main",
      sha: "abcdef1234567890",
      detached: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      gone: false,
      path: "/srv/app",
    });
  });

  it("carries `gone` through — it is the answer the panel is opened for", () => {
    expect(repoHead(row(), [ref({ gone: true, ahead: 0, behind: 0 })])?.gone).toBe(true);
  });

  it("reports a detached HEAD instead of joining to a branch that is not checked out", () => {
    const head = repoHead(row({ detached: true, headBranch: null, ahead: 4 }), [ref()]);
    expect(head?.detached).toBe(true);
    expect(head?.upstream).toBeNull();
    // No branch row to read, so the repo's own divergence stands.
    expect(head?.ahead).toBe(4);
  });

  it("falls back to the repo's divergence when the branch has no ref row", () => {
    const head = repoHead(row({ ahead: 1, behind: 2 }), []);
    expect([head?.upstream, head?.ahead, head?.behind, head?.gone]).toEqual([null, 1, 2, false]);
    expect(repoHead(null, [ref()])).toBeNull();
  });
});

describe("[TC-PDUI-107] working tree summary", () => {
  const repo = (overrides: Partial<RepoRow> = {}): RepoRow => ({
    id: "p1",
    hostId: "h1",
    path: "/srv/app",
    name: "app",
    headBranch: "main",
    headSha: "abc",
    detached: false,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    dirtySubmodules: 0,
    truncated: false,
    limit: 300,
    pendingDetails: 0,
    hasWorkingDiff: false,
    lastSnapshotAt: null,
  remoteRefs: null,
  remoteCheckedAt: null,
  remoteError: null,
    error: null,
    ...overrides,
  });

  it("draws no working-tree row for a clean checkout", () => {
    expect(uncommittedFor(repo(), null)).toBeNull();
  });

  it("uses the repo total before the patch is fetched", () => {
    expect(uncommittedFor(repo({ dirtyCount: 3 }), null)?.total).toBe(3);
  });

  it("uses the real per-kind counts once the working diff is loaded", () => {
    const summary = uncommittedFor(repo({ dirtyCount: 3 }), { staged: [1], unstaged: [1, 1], untracked: [] });
    expect(summary?.total).toBe(3);
    expect(summary?.parts).toEqual([
      { kind: "staged", count: 1 },
      { kind: "unstaged", count: 2 },
    ]);
  });

  it("lists staged, unstaged and untracked files in that order", () => {
    expect(workingDiffFiles({ staged: ["a"], unstaged: ["b"], untracked: ["c"] })).toEqual(["a", "b", "c"]);
    expect(workingDiffFiles(null)).toEqual([]);
  });
});

describe("[TC-PDUI-108] card reference details", () => {
  const labels = {
    address: "Address",
    agent: "Agent",
    system: "System",
    lastSeen: "Last seen",
    ssh: "SSH",
    never: "never",
  };

  it("drops empty values and always states when the host was last seen", () => {
    const details = hostDetails(host({ agentVersion: null, os: null, arch: null }), labels, () => "then");
    expect(details.map((detail) => detail.key)).toEqual(["address", "lastSeen", "ssh"]);
    expect(details.find((detail) => detail.key === "ssh")?.value).toBe("ssh 10.0.0.1");
  });

  it("says 'never' rather than leaving a blank for a host that never connected", () => {
    const details = hostDetails(host({ lastSeenAt: null }), labels, () => "then");
    expect(details.find((detail) => detail.key === "lastSeen")?.value).toBe("never");
  });

  it("reports no whereabouts, and no ssh line, for a loopback address", () => {
    // ⚠ `ssh 127.0.0.1` connects to whoever runs it, which is the one machine they did
    // not ask about. Dropping the address has to drop the command derived from it.
    const details = hostDetails(host({ address: "127.0.0.1" }), labels, () => "then");
    expect(details.map((detail) => detail.key)).toEqual(["agent", "system", "lastSeen"]);
  });
});

describe("[TC-PDWEB-013] an address is shown only when it says which host this is", () => {
  /**
   * REPORTED: the fleet table's Address column was either empty or `127.0.0.1`, and
   * neither told the reader anything. The blank is at least honest; the loopback is
   * worse than blank, because it looks like an answer while every host on the screen
   * would give that same one about itself.
   */
  it("keeps an address that distinguishes the host", () => {
    expect(hostAddress({ address: "10.0.0.1", agentAddress: null })).toBe("10.0.0.1");
    expect(hostAddress({ address: "build-01.internal", agentAddress: null })).toBe("build-01.internal");
    expect(hostAddress({ address: "  10.0.0.1  ", agentAddress: null })).toBe("10.0.0.1");
    // ⚠ NOT a blanket "private addresses are meaningless" rule. `10.x` and `192.168.x`
    // name a real, different machine on the operator's network — which is most fleets.
    expect(hostAddress({ address: "192.168.1.40", agentAddress: null })).toBe("192.168.1.40");
  });

  it("drops the ones that name no particular machine", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3", // the whole 127/8 loopback block, not just the famous one
      "LOCALHOST", // operator-typed, so case is not guaranteed
      "0.0.0.0", // a bind address that was never a destination
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ]) {
      expect(hostAddress({ address, agentAddress: null }), address).toBeNull();
      // ...and it is the same sieve whichever end it came from.
      expect(hostAddress({ address: null, agentAddress: address }), address).toBeNull();
    }
  });

  it("treats absent and blank alike", () => {
    expect(hostAddress({ address: null, agentAddress: null })).toBeNull();
    expect(hostAddress({ address: "", agentAddress: null })).toBeNull();
    expect(hostAddress({ address: "   ", agentAddress: null })).toBeNull();
  });

  it("falls back to what the agent reported when nobody typed one", () => {
    /**
     * ⚠ THE ONLY WAY THIS CELL CAN FILL ITSELF IN. A server sees the far end of a
     * socket and the agent dials OUT: measured on one deployment, one agent arrives
     * as `127.0.0.1` (it is the same machine) and another as a container-bridge
     * address belonging to the reverse proxy. Neither is a way back to the machine,
     * so the host is asked instead and answers in `hello`.
     */
    expect(hostAddress({ address: null, agentAddress: "172.31.6.118" })).toBe("172.31.6.118");
    expect(hostAddress({ address: "   ", agentAddress: "172.31.6.118" })).toBe("172.31.6.118");
    // A stored loopback is not an address, so the reported one is still the answer —
    // which is exactly the row that started this.
    expect(hostAddress({ address: "127.0.0.1", agentAddress: "172.31.6.118" })).toBe("172.31.6.118");
  });

  it("lets the operator's own answer win", () => {
    // They typed it on purpose, and it is what service links are built from. An agent
    // reporting the LAN side of a machine the operator reaches by another name must
    // not quietly replace the name they chose.
    expect(hostAddress({ address: "build-01.internal", agentAddress: "10.9.9.9" })).toBe("build-01.internal");
  });

  it("does NOT change how a service is reached", () => {
    // The operator typed it, and on the machine itself a loopback link does open the
    // service. Suppressing it here would break working links in order to fix a column.
    expect(serviceUrl(host({ address: "127.0.0.1" }), service({ port: 5002, path: "/" }))).toBe(
      "http://127.0.0.1:5002",
    );
    // ⚠ And a REPORTED address never becomes a link. Building one from a value nobody
    // chose is the product guessing where a service lives — the very thing serviceUrl
    // refuses to do when it declines to fall back to localhost.
    expect(serviceUrl(host({ address: null, agentAddress: "172.31.6.118" }), service())).toBe("");
  });
});

describe("[TC-PDUI-114] pickerHosts carries whether a host has a multiplexer", () => {
  it("[TC-PDUI-114] reads the live heartbeat diagnostic, not the connect-time capability", () => {
    // Live matters: someone who installs a multiplexer expects the picker to offer
    // sessions on the next beat, not after the agent happens to reconnect.
    const [mapped] = pickerHosts([
      host({ diagnostics: [{ level: "warn", code: "mux.missing", message: "no multiplexer" }] }),
    ]);
    expect(mapped?.multiplexer).toBe(false);
  });

  it("[TC-PDUI-114] treats no diagnostic as having one", () => {
    // Absence of evidence is not evidence of absence — an agent too old to report
    // diagnostics at all must keep its session targets.
    expect(pickerHosts([host()])[0]?.multiplexer).toBe(true);
    const unrelated = host({ diagnostics: [{ level: "warn", code: "git.missing", message: "" }] });
    expect(pickerHosts([unrelated])[0]?.multiplexer).toBe(true);
  });

  it("[TC-PDUI-114] still hides a disabled host, which is a separate reason", () => {
    // The two are computed in one place on purpose; a second `online` derived here
    // is how they drift.
    expect(pickerHosts([host({ enabled: false })])[0]?.online).toBe(false);
  });
});

describe("[TC-PDWEB-027] a service that was turned off", () => {
  it("[TC-PDWEB-027] leaves the card's launcher", () => {
    // The other half of what "off" means. The server already stopped probing it;
    // leaving it here would put it one mis-click from being opened, with no
    // status beside it because nothing is measuring it any more.
    const options = serviceOptionsFor(
      host({
        address: "10.0.0.1",
        services: [service({ id: "s1", label: "api", port: 3000 }), service({ id: "s2", label: "parked", port: 9999, enabled: false })],
      }),
    );
    expect(options.map((option) => option.label)).toEqual(["api"]);
  });

  it("[TC-PDWEB-027] keeps a service whose state an older API did not send", () => {
    // ⚠ THIS IS A ROLLING-DEPLOY CASE, NOT A HYPOTHETICAL. During a deploy the
    // browser can hold a build newer than the API answering it, and that API's
    // rows carry no `enabled` at all. Reading the gap as "off" would empty the
    // launcher of every service on every host for the length of the rollout.
    const legacy = { id: "s1", label: "api", port: 3000, probe: "tcp", path: "/", urlTemplate: null, sortOrder: 0, status: "up", latencyMs: 1 } as unknown as HostServiceView;
    const options = serviceOptionsFor(host({ address: "10.0.0.1", services: [legacy] }));
    expect(options.map((option) => option.label)).toEqual(["api"]);
  });
});
