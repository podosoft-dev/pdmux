import { ApiError } from "@podosoft/podokit-api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView, MetricsResponse, PrefsView } from "../src/lib/dashboard/types";

vi.mock("../src/lib/dashboard/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/dashboard/api")>()),
  hostsApi: { list: vi.fn() },
  metricsApi: { series: vi.fn() },
  prefsApi: { putLayout: vi.fn(async () => undefined), putHostPref: vi.fn(async () => undefined) },
}));

const { hostsApi, metricsApi } = await import("../src/lib/dashboard/api");
const { FleetFeed } = await import("../src/lib/dashboard/fleet-feed.svelte");
const { ServerConnection } = await import("../src/lib/dashboard/server-connection.svelte");
const { ShellState } = await import("../src/lib/dashboard/shell-state.svelte");
const { FLEET_SETTING_FALLBACK } = await import("../src/lib/dashboard/fleet-settings");

function host(id: string): HostView {
  return { id, label: id, enabled: true, online: true, sessions: [] } as unknown as HostView;
}

function series(hostId: string): MetricsResponse {
  return { hostId, t: [], cpu: [], mem: [], disk: [], swap: [], step: 30, window: 3600, latest: null };
}

afterEach((): void => {
  vi.useRealTimers();
  vi.mocked(hostsApi.list).mockReset();
  vi.mocked(metricsApi.series).mockReset();
});

describe("[TC-PDWEB-046] an unreachable server keeps the rows but stops vouching for them", () => {
  it("keeps the hosts, advances the clock and marks the connection lost; a refusal is not an outage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const feed = new FleetFeed({ initialHosts: [host("a")], includeHistory: false });
    vi.mocked(hostsApi.list).mockResolvedValueOnce([host("a"), host("b")]);
    await feed.refresh();
    expect(feed.connection.state).toBe("online");
    const answeredAt = feed.lastSuccessAt;

    vi.setSystemTime(1_060_000);
    vi.mocked(hostsApi.list).mockRejectedValueOnce(new ApiError("BAD_GATEWAY", "Bad Gateway", 502));
    await feed.refresh();
    expect(feed.hosts.map((row) => row.id)).toEqual(["a", "b"]);
    expect(feed.connection.state).toBe("reconnecting");
    expect(feed.stale).toBe(true);
    // ⚠ The clock is not frozen at the last answer: "last seen" keeps counting.
    expect(feed.now).toBe(1_060_000);
    expect(feed.lastSuccessAt).toBe(answeredAt);

    const other = new FleetFeed({ initialHosts: [host("a")], includeHistory: false });
    vi.mocked(hostsApi.list).mockRejectedValueOnce(new ApiError("UNAUTHORIZED", "no", 401));
    await other.refresh();
    expect(other.connection.state).toBe("online");
  });
});

describe("[TC-PDWEB-047] coming back reads the hosts and their trends again", () => {
  it("runs the full reload once on recovery, from a poll answer", async () => {
    const connection = new ServerConnection();
    const feed = new FleetFeed({ initialHosts: [host("a")], connection, heartbeatSec: 3600 });
    vi.mocked(hostsApi.list).mockResolvedValue([host("a")]);
    vi.mocked(metricsApi.series).mockResolvedValue(series("a"));
    feed.start();
    await vi.waitFor(() => expect(metricsApi.series).toHaveBeenCalledTimes(1));
    vi.mocked(metricsApi.series).mockClear();
    vi.mocked(hostsApi.list).mockClear();

    connection.lost();
    vi.mocked(hostsApi.list).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await feed.refresh();
    expect(metricsApi.series).not.toHaveBeenCalled();

    await feed.refresh();
    expect(connection.state).toBe("online");
    // The poll that answered, then the recovery's own read of the hosts and of every trend.
    await vi.waitFor(() => expect(metricsApi.series).toHaveBeenCalledTimes(1));
    expect(vi.mocked(hostsApi.list).mock.calls.length).toBeGreaterThanOrEqual(3);
    feed.stop();
  });
});

describe("[TC-PDWEB-051] a pane is cut off when the server is gone or its host's socket stays away", () => {
  it("covers every host's panes while the server is unreachable, and one host's after its socket outlasts the grace", () => {
    vi.useFakeTimers();
    const shell = new ShellState({
      hosts: [host("a"), host("b")],
      hostsOk: true,
      prefs: { layouts: [], hostPrefs: {} } as unknown as PrefsView,
      prefsOk: true,
      fleet: FLEET_SETTING_FALLBACK,
      relayMessages: {},
    });
    expect(shell.paneCutOff("a")).toBe(false);
    shell.feed.connection.lost();
    expect([shell.paneCutOff("a"), shell.paneCutOff("b")]).toEqual([true, true]);
    shell.feed.connection.alive();
    expect(shell.paneCutOff("a")).toBe(false);

    shell.transportLoss.note("b", "reconnecting");
    vi.advanceTimersByTime(2_999);
    expect(shell.paneCutOff("b")).toBe(false);
    vi.advanceTimersByTime(1);
    expect([shell.paneCutOff("a"), shell.paneCutOff("b")]).toEqual([false, true]);
    shell.transportLoss.note("b", "open");
    expect(shell.paneCutOff("b")).toBe(false);
    shell.stop();
  });
});
