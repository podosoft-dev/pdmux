import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView, PrefsView } from "../src/lib/dashboard/types";

vi.mock("../src/lib/dashboard/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/dashboard/api")>()),
  hostsApi: { list: vi.fn(), remove: vi.fn() },
  prefsApi: { putLayout: vi.fn(), putHostPref: vi.fn() },
}));

const { hostsApi, prefsApi } = await import("../src/lib/dashboard/api");
const { FleetFeed } = await import("../src/lib/dashboard/fleet-feed.svelte");
const { ShellState } = await import("../src/lib/dashboard/shell-state.svelte");
const { FLEET_SETTING_FALLBACK } = await import("../src/lib/dashboard/fleet-settings");

function host(id: string): HostView {
  return { id, label: id, enabled: true, online: true, sessions: [] } as unknown as HostView;
}

/** A host read that is on the wire until the test answers it. */
function pendingRead(): { promise: Promise<HostView[]>; answer: (hosts: HostView[]) => void } {
  let answer!: (hosts: HostView[]) => void;
  const promise = new Promise<HostView[]>((resolve) => (answer = resolve));
  return { promise, answer };
}

afterEach((): void => {
  vi.useRealTimers();
  vi.mocked(hostsApi.list).mockReset();
  vi.mocked(hostsApi.remove).mockReset();
  vi.mocked(prefsApi.putLayout).mockReset();
});

/**
 * A read that left before a write must not answer for a refresh asked for after it.
 *
 * The feed reads `GET /hosts` on a poll and on every SSE invalidation, so a read is often
 * on the wire. `refresh()` used to hand a caller that read: a host deleted while it was in
 * flight came back as still present, the shell pruned nothing, and the saved layout kept a
 * pane on a host that no longer exists (TC-PDUI-166, seen in a full e2e run).
 */
describe("[TC-PDWEB-040] a refresh after a change reads after that change", () => {
  it("waits for the read on the wire and reads once more, shared by every caller meanwhile", async () => {
    const stale = pendingRead();
    vi.mocked(hostsApi.list).mockReturnValueOnce(stale.promise).mockResolvedValue([host("a")]);
    const feed = new FleetFeed({ initialHosts: [host("a"), host("b")] });

    const poll = feed.refresh();
    const afterWrite = feed.refresh();
    const another = feed.refresh();
    expect(hostsApi.list).toHaveBeenCalledTimes(1);

    stale.answer([host("a"), host("b")]);
    await poll;
    await afterWrite;
    await another;

    expect(hostsApi.list).toHaveBeenCalledTimes(2);
    expect(feed.hosts.map((row) => row.id)).toEqual(["a"]);
  });

  it("starts a read at once when none is on the wire", async () => {
    vi.mocked(hostsApi.list).mockResolvedValue([host("a")]);
    const feed = new FleetFeed({ initialHosts: [] });

    await feed.refresh();
    await feed.refresh();

    expect(hostsApi.list).toHaveBeenCalledTimes(2);
    expect(feed.hosts.map((row) => row.id)).toEqual(["a"]);
  });

  it("prunes and saves the layout when a host is removed during a fleet poll", async () => {
    vi.useFakeTimers();
    const prefs = {
      layouts: [
        {
          name: "default",
          isDefault: true,
          payload: {
            mode: "split4",
            slots: [
              { id: "s1", hostId: "a", kind: "shell", session: null },
              { id: "s2", hostId: "b", kind: "shell", session: null },
            ],
          },
        },
      ],
      hostPrefs: {},
    } as unknown as PrefsView;
    const shell = new ShellState({
      hosts: [host("a"), host("b")],
      hostsOk: true,
      prefs,
      prefsOk: true,
      fleet: FLEET_SETTING_FALLBACK,
      relayMessages: {},
    });
    expect(shell.layout.slots.map((slot) => slot?.hostId ?? null)).toEqual(["a", "b"]);

    // A poll reads the fleet before the delete lands, and answers just after it.
    const stale = pendingRead();
    vi.mocked(hostsApi.list).mockReturnValueOnce(stale.promise).mockResolvedValue([host("a")]);
    vi.mocked(hostsApi.remove).mockImplementation(async () => {
      setTimeout(() => stale.answer([host("a"), host("b")]), 10);
      return undefined as never;
    });
    vi.mocked(prefsApi.putLayout).mockResolvedValue(undefined);
    const poll = shell.feed.refresh();

    const removing = shell.removeHost("b");
    await vi.advanceTimersByTimeAsync(10);
    await poll;
    await removing;
    expect(hostsApi.remove).toHaveBeenCalledWith("b");

    expect(shell.layout.slots.map((slot) => slot?.hostId ?? null)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefsApi.putLayout).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(prefsApi.putLayout).mock.calls[0]?.[1] as { slots: ({ hostId: string } | null)[] };
    expect(saved.slots.map((slot) => slot?.hostId ?? null)).toEqual(["a"]);
    shell.stop();
  });
});
