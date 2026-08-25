import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Heartbeat } from "@pdmux/protocol";
import { AppException } from "../common/app-exception";
import { ProductLogger } from "../logging/product-logger";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import type { PublishedRelease } from "../agents/agent-release.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { HostGitRoot } from "./host-git-root.entity";
import { HostService } from "./host-service.entity";
import { Host } from "./host.entity";
import { HostsService } from "./hosts.service";

const ORG_A = "org-a";
const ORG_B = "org-b";

function build(releases: PublishedRelease[] = [], users: Record<string, string> = {}): {
  service: HostsService;
  hosts: FakeRepository<Host>;
  services: FakeRepository<HostService>;
} {
  const hosts = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  // `enabled: true` mirrors the column default — a service is registered in order
  // to be watched, so a fixture that omits it would describe a row the database
  // cannot produce.
  const services = new FakeRepository<HostService>({ sortOrder: 0, probe: "tcp", path: "/", enabled: true });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  return {
    service: new HostsService(
      hosts.asRepository(),
      services.asRepository(),
      gitRootRepo.asRepository(),
      settings,
      fakeAgentReleases(releases),
      fakeDataSource(users),
    ),
    hosts,
    services,
  };
}

async function expectAppException(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: unknown) => {
    expect((error as AppException).code).toBe(code);
  });
}

describe("HostsService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDHOST-001] creates a host in the caller's scope with sane defaults", async () => {
    const host = await ctx.service.create(ORG_A, { label: "build-01" });

    expect(host.organizationId).toBe(ORG_A);
    expect(host.enabled).toBe(true);
    expect(host.sortOrder).toBe(0);
    expect(host.tags).toEqual([]);

    const second = await ctx.service.create(ORG_A, { label: "build-02" });
    expect(second.sortOrder).toBe(1);
  });

  it("[TC-PDAGENT-063] hands over an enrollment code as part of registering the host", async () => {
    const asked: string[] = [];
    ctx.service.setEnrollmentIssuer(async (organizationId, hostId, createdByUserId) => {
      asked.push(`${organizationId} ${hostId} ${createdByUserId ?? "-"}`);
      return {
        id: "enrollment-1",
        code: "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        expiresInSec: 900,
      };
    });

    const created = await ctx.service.createWithEnrollment(ORG_A, { label: "build-01" }, "user-1");

    // One action, one thing to copy: the row AND the secret that turns it into a
    // machine come back together.
    expect(created.label).toBe("build-01");
    expect(created.enrollment).toMatchObject({ id: "enrollment-1", code: "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW" });
    // The code is minted for the host that was just written, in the caller's scope.
    expect(asked).toEqual([`${ORG_A} ${created.id} user-1`]);
    // ...and the host is an ordinary host, defaults and all.
    expect(await ctx.service.get(ORG_A, created.id)).toMatchObject({ label: "build-01", enabled: true });
  });

  it("[TC-PDAGENT-063] keeps the host when minting its code fails", async () => {
    const warn = spyOn(ProductLogger.prototype, "warn").mockImplementation(() => undefined);
    ctx.service.setEnrollmentIssuer(() => Promise.reject(new Error("mint unavailable")));

    const created = await ctx.service.createWithEnrollment(ORG_A, { label: "build-01" }, "user-1");

    // The host is the durable thing. A 15-minute secret must not be able to undo a
    // registration the operator completed — "regenerate" is one click away, and a
    // 5xx here would leave them re-typing the form instead.
    expect(created.enrollment).toBeNull();
    expect(await ctx.service.get(ORG_A, created.id)).toMatchObject({ label: "build-01" });
    // Silently swallowing it is the other failure: the miss is logged.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without an enrollment code"));

    // Same answer on a server where nothing wired an issuer at all — that is a
    // wiring bug, not a reason to refuse to register hosts.
    const unwired = build().service;
    expect((await unwired.createWithEnrollment(ORG_A, { label: "build-02" }, null)).enrollment).toBeNull();
    warn.mockRestore();
  });

  it("[TC-PDHOST-002] rejects a duplicate label inside a scope but allows it in another", async () => {
    await ctx.service.create(ORG_A, { label: "build-01" });

    await expectAppException(ctx.service.create(ORG_A, { label: "build-01" }), "HOST_LABEL_TAKEN");

    const other = await ctx.service.create(ORG_B, { label: "build-01" });
    expect(other.organizationId).toBe(ORG_B);
  });

  it("[TC-PDHOST-004] never exposes another organization's host", async () => {
    const owned = await ctx.service.create(ORG_A, { label: "build-01" });

    await expectAppException(ctx.service.get(ORG_B, owned.id), "HOST_NOT_FOUND");
    await expectAppException(ctx.service.update(ORG_B, owned.id, { label: "stolen" }), "HOST_NOT_FOUND");
    await expectAppException(ctx.service.remove(ORG_B, owned.id), "HOST_NOT_FOUND");
    await expectAppException(ctx.service.setEnabled(ORG_B, owned.id, false), "HOST_NOT_FOUND");

    expect(await ctx.service.list(ORG_B)).toEqual([]);
    // The row is untouched by the failed cross-tenant attempts.
    expect((await ctx.service.get(ORG_A, owned.id)).label).toBe("build-01");
  });

  it("[TC-PDHOST-005] reorders hosts and refuses ids outside the scope", async () => {
    const first = await ctx.service.create(ORG_A, { label: "a" });
    const second = await ctx.service.create(ORG_A, { label: "b" });
    const foreign = await ctx.service.create(ORG_B, { label: "c" });

    const reordered = await ctx.service.reorder(ORG_A, [second.id, first.id]);
    expect(reordered.map((host) => host.label)).toEqual(["b", "a"]);
    expect(reordered.map((host) => host.sortOrder)).toEqual([0, 1]);

    await expectAppException(ctx.service.reorder(ORG_A, [first.id, foreign.id]), "HOST_NOT_FOUND");
    // A rejected reorder must not have written a partial order.
    const after = await ctx.service.list(ORG_A);
    expect(after.map((host) => host.label)).toEqual(["b", "a"]);
  });

  it("[TC-PDHOST-006] enables, disables and deletes a host", async () => {
    const host = await ctx.service.create(ORG_A, { label: "build-01" });

    expect((await ctx.service.setEnabled(ORG_A, host.id, false)).enabled).toBe(false);
    expect((await ctx.service.setEnabled(ORG_A, host.id, true)).enabled).toBe(true);

    expect(await ctx.service.remove(ORG_A, host.id)).toEqual({ id: host.id, label: "build-01" });
    expect(await ctx.service.list(ORG_A)).toEqual([]);
  });

  it("[TC-PDHOST-007] paints the sidebar in one call: services joined to probe results", async () => {
    const host = await ctx.service.create(ORG_A, { label: "build-01" });
    const api = await ctx.services.save(
      ctx.services.create({ hostId: host.id, label: "api", port: 5002, probe: "http", path: "/health", sortOrder: 0 }),
    );
    const admin = await ctx.services.save(
      ctx.services.create({ hostId: host.id, label: "admin", port: 4000, probe: "tcp", path: "/", sortOrder: 1 }),
    );

    const heartbeat: Heartbeat = {
      ts: Math.floor(Date.now() / 1000),
      resource: {
        cpuPct: 12,
        memPct: 41,
        diskPct: 63,
        memUsedBytes: null,
        memTotalBytes: null,
        diskUsedBytes: null,
        diskTotalBytes: null,
        swapPct: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        load1: null,
        uptimeSec: null,
      },
      sessions: [{ name: "main", attached: 1, windows: 3 }],
      usage: [],
      diagnostics: [{ level: "warn", code: "git-missing", message: "git is not installed" }],
      services: [{ id: api.id, status: "up", latencyMs: 3 }],
      listeners: [{ port: 5173, process: "node", loopbackOnly: true }],
    };
    await ctx.service.applyHeartbeat(host.id, heartbeat);

    const [view] = await ctx.service.list(ORG_A);
    expect(view?.online).toBe(true);
    expect(view?.resource?.cpuPct).toBe(12);
    expect(view?.sessions).toHaveLength(1);
    // Degraded capabilities belong on the card — in `doctor` output on the host
    // nobody sees them until they already suspect a problem.
    expect(view?.diagnostics).toEqual([{ level: "warn", code: "git-missing", message: "git is not installed" }]);
    expect(view?.services.map((s) => [s.label, s.status])).toEqual([
      ["api", "up"],
      // No probe result reported for admin: "unknown", never a red "down".
      ["admin", "unknown"],
    ]);
    expect(view?.services.find((s) => s.id === admin.id)?.latencyMs).toBeNull();
    // Discovered ports ride the same call. They are NOT joined to the registered
    // services here — the browser subtracts one from the other, because "which of
    // these is already registered" is a question about what to show, and this
    // layer has no business deciding it.
    expect(view?.listeners).toEqual([{ port: 5173, process: "node", loopbackOnly: true }]);
  });

  it("[TC-PDHOST-019] an agent that never reported ports is not made to say 'none'", async () => {
    // ⚠ MEASURED ON A REAL HOST, AND THE REASON THE CONTRACT FIELD HAS NO
    // DEFAULT. The server parses every frame before storing it, so a default
    // filled the absence in and the row came back `listeners: []`. The dashboard
    // then told that host's owner "nothing is listening here" — a claim its agent
    // had never made, about a host nobody had asked. `null` is the agent saying
    // nothing; `[]` is the agent saying none.
    const host = await ctx.service.create(ORG_A, { label: "old-agent" });
    const beat = {
      ts: Math.floor(Date.now() / 1000),
      resource: { cpuPct: 5 },
      sessions: [],
      usage: [],
      services: [],
      diagnostics: [],
    } as unknown as Heartbeat;
    await ctx.service.applyHeartbeat(host.id, beat);

    const view = await ctx.service.getView(ORG_A, host.id);
    expect(view.listeners).toBeNull();

    // And a current agent that looked and found none still says so, distinctly.
    await ctx.service.applyHeartbeat(host.id, { ...beat, listeners: [] } as unknown as Heartbeat);
    expect((await ctx.service.getView(ORG_A, host.id)).listeners).toEqual([]);
  });

  it("[TC-PDHOST-019] carries the on/off state of each service to the card", async () => {
    const host = await ctx.service.create(ORG_A, { label: "toggles" });
    await ctx.services.save(
      ctx.services.create({ hostId: host.id, label: "api", port: 5002, probe: "tcp", path: "/", sortOrder: 0 }),
    );
    await ctx.services.save(
      ctx.services.create({
        hostId: host.id,
        label: "parked",
        port: 9999,
        probe: "tcp",
        path: "/",
        sortOrder: 1,
        enabled: false,
      }),
    );

    const view = await ctx.service.getView(ORG_A, host.id);
    // Registering defaults to on — a service is registered in order to be watched.
    expect(view.services.map((s) => [s.label, s.enabled])).toEqual([
      ["api", true],
      ["parked", false],
    ]);
  });

  it("[TC-PDHOST-011] carries the agent version state, resolved per platform", async () => {
    const artifacts = (version: string, platforms: [string, string][]): PublishedRelease => ({
      version,
      artifacts: platforms.map(([os, arch]) => ({
        os,
        arch,
        path: `/agent/${version}/pdmux-agent-${os}-${arch}`,
        sha256: "b".repeat(64),
        bytes: 9_000_000,
      })),
    });
    // 1.3.0 shipped no Mac build.
    ctx = build([
      artifacts("1.2.0", [
        ["linux", "amd64"],
        ["darwin", "arm64"],
      ]),
      artifacts("1.3.0", [["linux", "amd64"]]),
    ]);

    const server = await ctx.service.create(ORG_A, { label: "build-01" });
    const laptop = await ctx.service.create(ORG_A, { label: "laptop" });
    const fresh = await ctx.service.create(ORG_A, { label: "never-connected" });
    await ctx.service.applyHello(server.id, {
      protocolVersion: 1,
      agentVersion: "1.2.0",
      hostname: "build-01",
      address: "10.0.0.7",
      os: "linux",
      arch: "amd64",
      capabilities: [],
      update: { canRestart: true, restartMode: "systemd" },
    });
    await ctx.service.applyHello(laptop.id, {
      protocolVersion: 1,
      agentVersion: "1.2.0",
      hostname: "laptop",
      // An agent that found no routable interface, or one built before the field
      // existed: empty is a real answer and must not become the string "".
      address: "",
      os: "darwin",
      arch: "arm64",
      capabilities: [],
      update: { canRestart: true, restartMode: "launchd" },
    });

    const views = new Map((await ctx.service.list(ORG_A)).map((view) => [view.id, view]));
    // The host's own answer to "where can I be reached", which the server cannot work
    // out for itself — it only ever sees the far end of a socket the agent dialled out.
    expect(views.get(server.id)?.agentAddress).toBe("10.0.0.7");
    expect(views.get(laptop.id)?.agentAddress).toBeNull();
    expect(views.get(fresh.id)?.agentAddress).toBeNull();
    expect(views.get(server.id)).toMatchObject({
      agentVersion: "1.2.0",
      latestAgentVersion: "1.3.0",
      agentVersionState: "outdated",
    });
    // Same agent version, different platform: 1.3.0 has nothing for it, so it is
    // current — a release without a Mac build must not paint the Mac amber.
    expect(views.get(laptop.id)).toMatchObject({
      agentVersion: "1.2.0",
      latestAgentVersion: "1.2.0",
      agentVersionState: "current",
    });
    // Never connected: nothing to compare, so "unknown" — the state that exists
    // precisely so a host we cannot judge is not reported as behind.
    expect(views.get(fresh.id)).toMatchObject({
      latestAgentVersion: null,
      agentVersionState: "unknown",
      lastUpdate: null,
    });
  });
});

/**
 * Handing a host to another account.
 *
 * Registration happens under whichever account the person was signed in as, so a
 * machine routinely lands in the wrong one. These pin the correction — and that it
 * is a correction, not a share: the row moves whole, and nothing about the agent
 * changes.
 */
describe("[TC-PDHOST-016] moving a host to another account", () => {
  const SCOPE_B = "personal:user-b";

  it("[TC-PDHOST-016] moves the row and leaves everything hanging off it alone", async () => {
    const { service, hosts } = build([], { "b@example.com": "user-b" });
    const host = await service.create(ORG_A, { label: "build-01" });
    // Something already in the destination, so the new arrival must be ordered
    // AFTER it rather than colliding with its position.
    await service.create(SCOPE_B, { label: "their-box" });

    const moved = await service.move(ORG_A, host.id, "b@example.com");

    expect(moved.organizationId).toBe(SCOPE_B);
    // Same row: the id is what tokens, services, repositories and samples hang off,
    // so keeping it is what makes "the agent does not notice" true.
    expect(moved.id).toBe(host.id);
    expect(hosts.rows).toHaveLength(2);
    expect((await service.list(ORG_A)).map((row) => row.id)).not.toContain(host.id);
    expect((await service.list(SCOPE_B)).map((row) => row.id)).toContain(host.id);
  });

  it("[TC-PDHOST-016] re-numbers it in the destination instead of keeping its old position", async () => {
    const { service } = build([], { "b@example.com": "user-b" });
    await service.create(SCOPE_B, { label: "first" });
    await service.create(SCOPE_B, { label: "second" });
    const host = await service.create(ORG_A, { label: "only-one-here" });
    // sortOrder 0 in its old scope — reusing it would drop this row on top of
    // somebody else's first card.
    expect(host.sortOrder).toBe(0);

    const moved = await service.move(ORG_A, host.id, "b@example.com");
    expect(moved.sortOrder).toBe(2);
  });

  it("[TC-PDHOST-017] refuses a label the destination already uses, and changes nothing", async () => {
    const { service } = build([], { "b@example.com": "user-b" });
    const host = await service.create(ORG_A, { label: "build-01" });
    await service.create(SCOPE_B, { label: "build-01" });

    // The exact case that prompted this: the same machine registered twice under
    // two accounts, with the same name.
    await expectAppException(service.move(ORG_A, host.id, "b@example.com"), "HOST_LABEL_TAKEN");
    expect((await service.get(ORG_A, host.id)).organizationId).toBe(ORG_A);
  });

  it("[TC-PDHOST-017] refuses an address no account holds", async () => {
    const { service } = build([], { "b@example.com": "user-b" });
    const host = await service.create(ORG_A, { label: "build-01" });
    await expectAppException(service.move(ORG_A, host.id, "nobody@example.com"), "USER_NOT_FOUND");
    expect((await service.get(ORG_A, host.id)).organizationId).toBe(ORG_A);
  });

  it("[TC-PDHOST-017] refuses moving a host to the scope it is already in", async () => {
    const { service } = build([], { "a@example.com": "user-a" });
    const host = await service.create("personal:user-a", { label: "build-01" });
    await expectAppException(service.move("personal:user-a", host.id, "a@example.com"), "HOST_ALREADY_IN_SCOPE");
  });

  it("[TC-PDHOST-018] cannot move a host belonging to somebody else", async () => {
    const { service } = build([], { "b@example.com": "user-b" });
    const host = await service.create(ORG_A, { label: "build-01" });

    // 404, not 403 — telling B that the id exists is the leak the scope filter exists
    // to prevent, and moving is no exception to it.
    await expectAppException(service.move(ORG_B, host.id, "b@example.com"), "HOST_NOT_FOUND");
    expect((await service.get(ORG_A, host.id)).organizationId).toBe(ORG_A);
  });
});
