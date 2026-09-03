import { beforeEach, describe, expect, it } from "bun:test";
import type { Heartbeat } from "@pdmux/protocol";
import { ReadinessService } from "../health/readiness.service";
import { EventsService } from "../events/events.service";
import { MemoryEventsTransport } from "../events/events.transport";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { GitIngestService } from "../git/git-ingest.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { HostMetricSample } from "../metrics/host-metric-sample.entity";
import { MetricsService } from "../metrics/metrics.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentAckService } from "./agent-ack.service";
import { AgentExecService } from "./agent-exec.service";
import { AgentFilesService } from "./agent-files.service";
import { AgentIngestService } from "./agent-ingest.service";
import { AgentRegistryService } from "./agent-registry.service";

const ORG = "org-a";
const ORG_OTHER = "org-b";

function heartbeat(ts: number, cpuPct: number): Heartbeat {
  return {
    ts,
    resource: {
      cpuPct,
      memPct: 40,
      diskPct: 50,
      memUsedBytes: 1024,
      memTotalBytes: 4096,
      diskUsedBytes: null,
      diskTotalBytes: null,
      swapPct: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      load1: null,
      uptimeSec: null,
    },
    sessions: [],
    usage: [],
    diagnostics: [],
    listeners: [],
    services: [],
    cloudflared: { state: "off", version: null, errorCode: null },
  };
}

function build(): {
  ingest: AgentIngestService;
  hosts: HostsService;
  hostRepo: FakeRepository<Host>;
  settings: FleetSettingsService;
  samples: FakeRepository<HostMetricSample>;
  events: EventsService;
  published: unknown[];
  registry: AgentRegistryService;
  exec: { settle: (result: unknown) => number; settled: unknown[] };
  files: { settle: (answer: unknown) => number; listed: unknown[] };
} {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(hostRepo.asRepository(), serviceRepo.asRepository(), gitRootRepo.asRepository(), settings, fakeAgentReleases(), fakeDataSource());
  const samples = new FakeRepository<HostMetricSample>();
  const metrics = new MetricsService(samples.asRepository());
  // EventsService gained a transport and a readiness registration in PodoKit 0.16.
  // The in-memory transport delivers locally, and connect() installs the handler
  // synchronously, so the assertions below still see events without awaiting here.
  const events = new EventsService(new MemoryEventsTransport(), new ReadinessService());
  void events.connect();
  const published: unknown[] = [];
  events.subscribe((event) => published.push(event));
  const registry = new AgentRegistryService();
  // Git ingest is exercised in its own spec; here it must simply never be reached
  // by a malformed frame.
  const git = {
    ingest: async () => ({
      repos: 0,
      newCommits: 0,
      storedDetails: 0,
      skippedDetails: 0,
      repoPathsWithNewDetails: [],
    }),
  };
  const ack = { ackRepoPaths: async () => 0, ackAllRepos: async () => 0 };
  // An exec result is relayed to whoever is blocked on it and stored nowhere, so
  // the double here only has to record that it was handed over.
  const settled: unknown[] = [];
  const exec = { settle: (result: unknown) => settled.push(result), settled };
  // A directory listing is relayed the same way and stored nowhere either — it is
  // true for an instant, so there is nothing a row could keep.
  const listed: unknown[] = [];
  const files = { settle: (answer: unknown) => listed.push(answer), listed };
  const ingest = new AgentIngestService(
    hosts,
    metrics,
    git as unknown as GitIngestService,
    settings,
    events,
    registry,
    ack as unknown as AgentAckService,
    exec as unknown as AgentExecService,
    files as unknown as AgentFilesService,
  );
  return { ingest, hosts, hostRepo, settings, samples, events, published, registry, exec, files };
}

describe("AgentIngestService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDAGENT-055] rejects malformed agent input without throwing", async () => {
    const host = await ctx.hosts.create(ORG, { label: "build-01" });

    const cases: unknown[] = [
      null,
      "not an object",
      { type: "nope" },
      { type: "heartbeat" },
      { type: "heartbeat", heartbeat: { ts: -1, resource: {} } },
      { type: "heartbeat", heartbeat: { ts: 1, resource: { cpuPct: 900 } } },
      { type: "hello", hello: { protocolVersion: 1 } },
      { type: "repos", ts: 1, repos: "nope" },
    ];
    for (const frame of cases) {
      const outcome = await ctx.ingest.handle(host.id, frame);
      expect(outcome.ok).toBe(false);
    }
    // Nothing was written and nothing was announced.
    expect(ctx.samples.rows).toHaveLength(0);
    expect(ctx.published).toHaveLength(0);
    expect((await ctx.hosts.get(ORG, host.id)).lastSeenAt).toBeUndefined();
  });

  it("[TC-PDAGENT-056] a heartbeat updates the host, stores a sample and reaches the SSE stream", async () => {
    const host = await ctx.hosts.create(ORG, { label: "build-01" });
    const now = Math.floor(Date.now() / 1000);

    const outcome = await ctx.ingest.handle(host.id, { type: "heartbeat", heartbeat: heartbeat(now, 12) });
    expect(outcome).toEqual({ ok: true, type: "heartbeat", sampled: true });

    const stored = await ctx.hosts.get(ORG, host.id);
    expect(stored.lastSeenAt).toBeInstanceOf(Date);
    expect(stored.lastHeartbeat?.resource.cpuPct).toBe(12);
    expect(ctx.samples.rows).toHaveLength(1);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({ type: "host.heartbeat", hostId: host.id });

    // A second beat inside the 30s default step updates the card but stores nothing.
    const second = await ctx.ingest.handle(host.id, { type: "heartbeat", heartbeat: heartbeat(now + 5, 44) });
    expect(second).toEqual({ ok: true, type: "heartbeat", sampled: false });
    expect(ctx.samples.rows).toHaveLength(1);
    expect((await ctx.hosts.get(ORG, host.id)).lastHeartbeat?.resource.cpuPct).toBe(44);
  });

  it("[TC-PDHOST-011] stores the newest update status and announces it", async () => {
    const host = await ctx.hosts.create(ORG, { label: "build-01" });
    const commandId = "0f1e5b9c-4a3d-4f2b-9c8e-2b7d6a5c4e31";

    const accepted = await ctx.ingest.handle(host.id, {
      type: "updateStatus",
      update: {
        commandId,
        phase: "downloading",
        currentVersion: "1.1.0",
        targetVersion: "1.2.0",
        progressPct: 40,
      },
    });
    expect(accepted).toEqual({ ok: true, type: "updateStatus" });
    const midway = await ctx.hosts.get(ORG, host.id);
    expect(midway.lastUpdate).toMatchObject({ phase: "downloading", progressPct: 40 });
    // The frame proves the agent is alive, exactly as a pong does.
    expect(midway.lastSeenAt).toBeInstanceOf(Date);

    // Progress and outcome share a shape, so the newest frame simply replaces it.
    await ctx.ingest.handle(host.id, {
      type: "updateStatus",
      update: { commandId, phase: "rolledBack", currentVersion: "1.1.0", targetVersion: "1.2.0", code: "VERIFY_FAILED" },
    });
    expect((await ctx.hosts.get(ORG, host.id)).lastUpdate).toMatchObject({
      phase: "rolledBack",
      code: "VERIFY_FAILED",
      currentVersion: "1.1.0",
    });
    expect(ctx.published).toHaveLength(2);
    expect(ctx.published[1]).toMatchObject({ type: "host.update", hostId: host.id });

    // A malformed status costs the frame, not the connection — and writes nothing.
    const bad = await ctx.ingest.handle(host.id, {
      type: "updateStatus",
      update: { commandId: "not-a-uuid", phase: "done", currentVersion: "1.2.0" },
    });
    expect(bad.ok).toBe(false);
    expect((await ctx.hosts.get(ORG, host.id)).lastUpdate).toMatchObject({ phase: "rolledBack" });
  });

  it("[TC-PDAGENT-055] applies hello and relays terminal frames to subscribers", async () => {
    const host = await ctx.hosts.create(ORG, { label: "build-01" });

    const hello = await ctx.ingest.handle(host.id, {
      type: "hello",
      hello: {
        protocolVersion: 1,
        agentVersion: "0.1.0",
        hostname: "build-01",
        os: "linux",
        arch: "x64",
        capabilities: ["metrics", "terminal"],
      },
    });
    expect(hello.ok).toBe(true);
    const stored = await ctx.hosts.get(ORG, host.id);
    expect(stored.agentVersion).toBe("0.1.0");
    expect(stored.capabilities).toEqual(["metrics", "terminal"]);

    const seen: string[] = [];
    ctx.registry.onTerminalFrame((hostId, frame) => seen.push(`${hostId}:${frame.type}`));
    const relayed = await ctx.ingest.handle(host.id, {
      type: "terminal",
      frame: { type: "output", termId: "t1", data: "hello" },
    });
    expect(relayed.ok).toBe(true);
    expect(seen).toEqual([`${host.id}:output`]);
  });
});

/**
 * The scope a frame is filed under comes from the host ROW, read now — not from a
 * copy taken when the socket was accepted.
 *
 * The gateway authenticates once, at the WebSocket upgrade, and used to hand the
 * `organizationId` it read there to every frame for the life of that socket. A
 * healthy agent holds one socket for days, so "for the life of the socket" means
 * "until something restarts it". Nothing can move a host between organizations
 * today — `UpdateHostDto` has no such field and no other endpoint writes the
 * column — so this was latent, not live. These tests are what keeps it that way
 * without anyone having to remember: they exercise a moved row directly, so they
 * describe the behaviour rather than forbidding the endpoint that would trigger it.
 */
describe("[TC-PDHOST-015] a frame is scoped by the host row, not by the connection that carried it", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDHOST-015] a heartbeat after the row moved organization is stepped by the NEW scope's settings", async () => {
    // Two scopes that disagree about how often a beat becomes a stored sample:
    // ORG keeps the 30s default, ORG_OTHER samples at most hourly.
    await ctx.settings.update(ORG_OTHER, { metricStepSec: 3600 });
    const host = await ctx.hosts.create(ORG, { label: "build-01" });
    const now = Math.floor(Date.now() / 1000);

    const first = await ctx.ingest.handle(host.id, { type: "heartbeat", heartbeat: heartbeat(now, 12) });
    expect(first).toEqual({ ok: true, type: "heartbeat", sampled: true });
    expect(ctx.samples.rows).toHaveLength(1);

    // The move an endpoint would make. There is deliberately no API for it, so the
    // row is edited directly — the point is that ingest reads it again, whatever
    // wrote it.
    const row = ctx.hostRepo.rows.find((candidate) => candidate.id === host.id);
    expect(row).toBeDefined();
    row!.organizationId = ORG_OTHER;

    // 60s later. Under the scope captured at connect (ORG, step 30) this beat is a
    // sample; under the scope the row now names (ORG_OTHER, step 3600) it is not.
    const moved = await ctx.ingest.handle(host.id, { type: "heartbeat", heartbeat: heartbeat(now + 60, 44) });
    expect(moved).toEqual({ ok: true, type: "heartbeat", sampled: false });
    expect(ctx.samples.rows).toHaveLength(1);

    // The frame was applied, not dropped — the card is current and the stream saw
    // it. Only the scope-dependent decision changed.
    expect((await ctx.hosts.get(ORG_OTHER, host.id)).lastHeartbeat?.resource.cpuPct).toBe(44);
    expect(ctx.published).toHaveLength(2);
  });

  it("[TC-PDHOST-015] a heartbeat for a host row that is gone is dropped, not absorbed", async () => {
    const host = await ctx.hosts.create(ORG, { label: "build-01" });
    const now = Math.floor(Date.now() / 1000);
    await ctx.hosts.remove(ORG, host.id);

    const outcome = await ctx.ingest.handle(host.id, { type: "heartbeat", heartbeat: heartbeat(now, 12) });

    // Previously this reported `ok` while writing nothing: the row update matched
    // zero rows and said so to nobody. Deleting a host now closes its socket
    // (TC-PDHOST-014), so this window is small — but a frame already in flight
    // lands in it, and "no such host" is the honest answer.
    expect(outcome).toEqual({ ok: false, error: "unknown host" });
    expect(ctx.samples.rows).toHaveLength(0);
    expect(ctx.published).toHaveLength(0);
  });
});
