import { beforeEach, describe, expect, it } from "bun:test";
import type { Repository } from "typeorm";

import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentAuthFailure } from "./agent-auth-failure.entity";
import { AgentAuthFailuresService } from "./agent-auth-failures.service";

const ORG = "org-a";
const IP = "203.0.113.7";

function context(): {
  failures: AgentAuthFailuresService;
  rows: FakeRepository<AgentAuthFailure>;
  hosts: HostsService;
} {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    serviceRepo.asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const rows = new FakeRepository<AgentAuthFailure>({ count: 1 });
  return { failures: new AgentAuthFailuresService(rows.asRepository(), hosts), rows, hosts };
}

describe("[TC-PDADMIN-050] refusals aggregate instead of accumulating", () => {
  let ctx: ReturnType<typeof context>;

  beforeEach(() => {
    ctx = context();
  });

  it("folds a repeated refusal into one row whose count climbs", async () => {
    // The shape of the failure this table exists for: an orphaned agent on a
    // backoff, refused the same way from the same address, forever. A row per
    // attempt would put one on the table every few seconds until somebody noticed
    // the disk — which is why the write is an UPSERT on (reason, hostId, sourceIp)
    // and not an insert. Revert it to an insert and this expectation fails.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await ctx.failures.record("revoked", "host-1", IP);
    }

    expect(ctx.rows.rows).toHaveLength(1);
    expect(ctx.rows.rows[0]?.count).toBe(25);
  });

  it("keeps a NULL host on one row too — the case a plain UNIQUE would miss", async () => {
    // `missing_key` and `unknown` are decided before any token resolves, so there
    // is no host to name. Postgres treats NULLs in a UNIQUE constraint as DISTINCT
    // by default, which would mean these rows conflict with nothing and every
    // retry inserts — the migration declares `NULLS NOT DISTINCT` for exactly this.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await ctx.failures.record("missing_key", null, IP);
      await ctx.failures.record("unknown", null, IP);
    }

    expect(ctx.rows.rows).toHaveLength(2);
    expect(ctx.rows.rows.map((row) => row.count)).toEqual([10, 10]);
  });

  it("separates rows the key separates: reason, host and source address", async () => {
    await ctx.failures.record("revoked", "host-1", IP);
    await ctx.failures.record("expired", "host-1", IP); // different reason
    await ctx.failures.record("revoked", "host-2", IP); // different host
    await ctx.failures.record("revoked", "host-1", "198.51.100.42"); // different source

    expect(ctx.rows.rows).toHaveLength(4);
    expect(ctx.rows.rows.every((row) => row.count === 1)).toBe(true);
  });

  it("keeps the first sighting and moves only the last", async () => {
    await ctx.failures.record("host_disabled", "host-1", IP);
    const first = (ctx.rows.rows[0] as unknown as AgentAuthFailure).firstSeenAt;
    expect(first).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await ctx.failures.record("host_disabled", "host-1", IP);

    // "Since when" is half the answer an operator needs; overwriting it would leave
    // only "recently", which every row says.
    const row = ctx.rows.rows[0] as unknown as AgentAuthFailure;
    expect(row.firstSeenAt).toEqual(first);
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(first.getTime());
  });

  it("records a refusal that arrived without any usable address", async () => {
    // The schema requires a source; a connection whose address could not be read
    // must still be counted rather than dropped on the floor.
    await ctx.failures.record("unknown", null, null);
    await ctx.failures.record("unknown", null, null);

    expect(ctx.rows.rows).toHaveLength(1);
    expect(ctx.rows.rows[0]?.sourceIp).toBe("unknown");
    expect(ctx.rows.rows[0]?.count).toBe(2);
  });

  it("never lets bookkeeping turn a refusal into an error", async () => {
    const unreachable = {
      findOne: (): Promise<never> => Promise.reject(new Error("relation does not exist")),
    } as unknown as Repository<AgentAuthFailure>;
    const service = new AgentAuthFailuresService(unreachable, ctx.hosts);

    // A diagnostic that can turn a 401 into a 500 is worse than no diagnostic — and
    // the gateway does not await this call, so a rejection here would surface as an
    // unhandled rejection rather than as anything a caller could act on.
    await expect(service.record("unknown", null, IP)).resolves.toBeUndefined();
  });

  it("reads newest first and names the host when there still is one", async () => {
    const host = await ctx.hosts.create(ORG, { label: "build-01" });
    await ctx.failures.record("revoked", host.id, IP);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ctx.failures.record("missing_key", null, IP);

    const listed = await ctx.failures.recent();
    expect(listed.map((row) => row.reason)).toEqual(["missing_key", "revoked"]);
    expect(listed[1]?.hostLabel).toBe("build-01");
    // A deleted host (or a refusal that never named one) still stands on its own —
    // there is no foreign key, precisely so `host_deleted` survives the deletion.
    expect(listed[0]?.hostLabel).toBeNull();
  });
});
