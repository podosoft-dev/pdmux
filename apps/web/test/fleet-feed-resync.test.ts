import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView, MetricsResponse } from "../src/lib/dashboard/types";

vi.mock("../src/lib/dashboard/api", () => ({
  errorCode: (): string => "NETWORK_ERROR",
  hostsApi: { list: vi.fn() },
  metricsApi: { series: vi.fn() },
}));

const { hostsApi, metricsApi } = await import("../src/lib/dashboard/api");
const { FleetFeed } = await import("../src/lib/dashboard/fleet-feed.svelte");

class TestDocument extends EventTarget {
  visibilityState = "visible";
}
class TestSource {
  static instances: TestSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) { TestSource.instances.push(this); }
  close(): void {}
  send(data: string): void { this.onmessage?.({ data } as MessageEvent<string>); }
}

function host(id: string): HostView {
  return { id, enabled: true } as HostView;
}

function series(hostId: string): MetricsResponse {
  return { hostId, t: [], cpu: [], mem: [], disk: [], swap: [], step: 30, window: 3600, latest: null };
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(hostsApi.list).mockReset();
  vi.mocked(metricsApi.series).mockReset();
  TestSource.instances = [];
});

describe("[TC-PDWEB-038] the fleet feed reloads what it shows on resync", () => {
  it("reads the hosts and then the trends of the hosts it now has, without reloading the page", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    vi.stubGlobal("document", new TestDocument());
    vi.stubGlobal("EventSource", TestSource);
    vi.stubGlobal("location", { reload: reloadPage });
    vi.mocked(hostsApi.list).mockResolvedValue([host("a")]);
    vi.mocked(metricsApi.series).mockImplementation(async (hostId: string) => series(hostId));
    const feed = new FleetFeed({ initialHosts: [host("a")], heartbeatSec: 5 });
    feed.start();
    await vi.waitFor(() => expect(metricsApi.series).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hostsApi.list).toHaveBeenCalledTimes(1));

    // A host arrived while the event bus was down; its notice never came.
    vi.mocked(hostsApi.list).mockResolvedValue([host("a"), host("b")]);
    TestSource.instances[0]!.send('{"type":"resync"}');
    await vi.waitFor(() => expect(feed.hosts.map((row) => row.id)).toEqual(["a", "b"]));
    await vi.waitFor(() => expect(Object.keys(feed.history).sort()).toEqual(["a", "b"]));
    expect(hostsApi.list).toHaveBeenCalledTimes(2);
    expect(vi.mocked(metricsApi.series).mock.calls.map(([hostId]) => hostId)).toEqual(["a", "a", "b"]);
    expect(reloadPage).not.toHaveBeenCalled();
    feed.stop();
  });
});
