import { beforeEach, describe, expect, it } from "@jest/globals";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AppException } from "../common/app-exception";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentDisconnectService } from "./agent-disconnect.service";
import { AgentRegistryService } from "./agent-registry.service";
import { AgentToken } from "./agent-token.entity";
import {
  AGENT_TOKEN_EXPIRY_DAYS,
  AGENT_TOKEN_PREFIX,
  expiryFrom,
  hashAgentToken,
} from "./agent-token.crypto";
import { AgentTokensService } from "./agent-tokens.service";
import { CreateAgentTokenDto } from "./dto/create-agent-token.dto";

const ORG_A = "org-a";
const ORG_B = "org-b";

function build(): { tokens: AgentTokensService; hosts: HostsService; rows: FakeRepository<AgentToken> } {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(hostRepo.asRepository(), serviceRepo.asRepository(), gitRootRepo.asRepository(), settings, fakeAgentReleases(), fakeDataSource());
  const rows = new FakeRepository<AgentToken>({ lastUsedAt: null, revokedAt: null, createdAt: new Date() });
  // Nothing is connected in these specs, so the disconnect service is exercised on
  // its no-op path — what a revocation does to a LIVE socket is TC-PDAGENT-075.
  const disconnect = new AgentDisconnectService(hosts, new AgentRegistryService());
  return { tokens: new AgentTokensService(rows.asRepository(), hosts, disconnect), hosts, rows };
}

describe("AgentTokensService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDAGENT-050] returns the plaintext once and stores only its hash", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    expect(minted.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(minted.token.length).toBeGreaterThan(AGENT_TOKEN_PREFIX.length + 30);

    const stored = ctx.rows.rows[0] as unknown as AgentToken;
    expect(stored.tokenHash).toBe(hashAgentToken(minted.token));
    expect(JSON.stringify(stored)).not.toContain(minted.token);

    // The list view never carries it again.
    const listed = await ctx.tokens.list(ORG_A, host.id);
    expect(JSON.stringify(listed)).not.toContain(minted.token);
  });

  it("[TC-PDAGENT-051] resolves a live token to its host and rejects everything else", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    expect((await ctx.tokens.resolve(minted.token))?.hostId).toBe(host.id);
    expect(await ctx.tokens.resolve("garbage")).toBeNull();
    expect(await ctx.tokens.resolve(`${AGENT_TOKEN_PREFIX}not-a-real-token-value`)).toBeNull();
    // The hash itself is not a credential.
    expect(await ctx.tokens.resolve(hashAgentToken(minted.token))).toBeNull();
  });

  it("[TC-PDAGENT-052] rotation issues a new secret and retires the old one", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const first = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    const second = await ctx.tokens.rotate(ORG_A, host.id, first.id);
    expect(second.token).not.toBe(first.token);
    expect(second.name).toBe("laptop");

    expect(await ctx.tokens.resolve(first.token)).toBeNull();
    expect((await ctx.tokens.resolve(second.token))?.hostId).toBe(host.id);

    // The retired row survives (with its evidence), it is not deleted.
    const listed = await ctx.tokens.list(ORG_A, host.id);
    expect(listed).toHaveLength(2);
    expect(listed.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });

  it("[TC-PDAGENT-053] revocation is idempotent and immediately blocks the token", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    const revoked = await ctx.tokens.revoke(ORG_A, host.id, minted.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await ctx.tokens.resolve(minted.token)).toBeNull();

    const again = await ctx.tokens.revoke(ORG_A, host.id, minted.id);
    expect(again.revokedAt).toBe(revoked.revokedAt);
  });

  it("[TC-PDAGENT-054] keeps tokens inside their host's organization", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    await expect(ctx.tokens.list(ORG_B, host.id)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.tokens.mint(ORG_B, host.id, "stolen")).rejects.toBeInstanceOf(AppException);
    await expect(ctx.tokens.rotate(ORG_B, host.id, minted.id)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.tokens.revoke(ORG_B, host.id, minted.id)).rejects.toBeInstanceOf(AppException);

    // Still usable by its real owner after the failed attempts.
    expect((await ctx.tokens.resolve(minted.token))?.hostId).toBe(host.id);
  });
});

/**
 * Expiry on an agent token is OPT-IN with a default of never, which is the opposite
 * of the MCP key next door. An agent token belongs to a machine that goes dark when
 * its credential lapses and cannot renew itself — Tailscale disables key expiry for
 * tagged server devices for exactly that reason. What this is for is the other case:
 * the short-lived agent somebody starts for one afternoon and forgets, which
 * otherwise keeps a working fleet credential forever.
 */
describe("AgentTokensService expiry", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDAGENT-066] defaults to never, so a real host is unaffected", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    expect(minted.expiresAt).toBeNull();
    expect(ctx.rows.rows[0]?.expiresAt).toBeNull();

    // A very long time later it still resolves: "never" is a real answer here, not
    // a large number that eventually runs out.
    const row = ctx.rows.rows[0] as unknown as AgentToken;
    expect(row.expiresAt).toBeNull();
    expect((await ctx.tokens.resolve(minted.token))?.hostId).toBe(host.id);
  });

  it("[TC-PDAGENT-066] stops working when it expires, without anybody revoking it", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "afternoon", 7);

    expect(minted.expiresAt).not.toBeNull();
    expect((await ctx.tokens.resolve(minted.token))?.hostId).toBe(host.id);

    const row = ctx.rows.rows[0] as unknown as AgentToken;
    row.expiresAt = new Date(Date.now() - 1000);

    expect(await ctx.tokens.resolve(minted.token)).toBeNull();
    // And it is still not revoked — the row's own evidence is untouched, which is
    // what tells an operator this lapsed rather than being taken away.
    expect(row.revokedAt).toBeNull();
  });

  it("[TC-PDAGENT-066] tells the gateway WHICH refusal it was, and tells nobody else", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const live = await ctx.tokens.mint(ORG_A, host.id, "laptop");
    const lapsed = await ctx.tokens.mint(ORG_A, host.id, "afternoon", 7);
    const lapsedRow = ctx.rows.rows.find((row) => row.id === lapsed.id) as unknown as AgentToken;
    lapsedRow.expiresAt = new Date(Date.now() - 1000);
    const gone = await ctx.tokens.mint(ORG_A, host.id, "old");
    await ctx.tokens.revoke(ORG_A, host.id, gone.id);

    // The gateway-only path distinguishes them, for the aggregate an administrator
    // reads. `unknown` names no host because no row was found.
    expect(await ctx.tokens.resolveOrReason("pdmux_nobody-ever-minted-this-value")).toEqual({
      refusal: "unknown",
      hostId: null,
    });
    expect(await ctx.tokens.resolveOrReason(lapsed.token)).toEqual({
      refusal: "expired",
      hostId: host.id,
    });
    expect(await ctx.tokens.resolveOrReason(gone.token)).toEqual({
      refusal: "revoked",
      hostId: host.id,
    });

    // ...and `resolve`, which is what every other caller uses, collapses all three
    // to the same null. A gate that answered differently would be an oracle.
    for (const secret of ["pdmux_nobody-ever-minted-this-value", lapsed.token, gone.token]) {
      expect(await ctx.tokens.resolve(secret)).toBeNull();
    }
    expect((await ctx.tokens.resolve(live.token))?.hostId).toBe(host.id);
  });

  it("[TC-PDAGENT-067] rotation carries the deadline rather than restarting it", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const first = await ctx.tokens.mint(ORG_A, host.id, "afternoon", 7);

    const second = await ctx.tokens.rotate(ORG_A, host.id, first.id);

    // Rotating replaces a secret that may have leaked; a leak is not a reason to
    // extend how long the machine stays authorised. A fresh window here would mean
    // anybody who rotates a 7-day token silently turns it into another 7 days,
    // forever, without ever deciding to.
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(second.token).not.toBe(first.token);
  });

  it("[TC-PDAGENT-067] keeps 'never' as never through a rotation", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const first = await ctx.tokens.mint(ORG_A, host.id, "laptop");

    const second = await ctx.tokens.rotate(ORG_A, host.id, first.id);
    expect(second.expiresAt).toBeNull();
  });

  it("[TC-PDAGENT-067] offers an allow-list of lengths, not a free-form number", async () => {
    // A free-form number is how a credential ends up living for ten years because
    // somebody typed an extra zero. The DTO holds the same list, so the screen and
    // the endpoint cannot drift.
    expect([...AGENT_TOKEN_EXPIRY_DAYS]).toEqual([7, 30, 90, 180, 365]);

    const check = (body: Record<string, unknown>): string[] =>
      validateSync(plainToInstance(CreateAgentTokenDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }).flatMap((error) => Object.keys(error.constraints ?? {}));

    // Omitted is the default and must stay valid — that is what a real host sends.
    expect(check({ name: "laptop" })).toEqual([]);
    expect(check({ name: "laptop", expiresInDays: 7 })).toEqual([]);
    expect(check({ name: "laptop", expiresInDays: 3650 })).not.toEqual([]);
    expect(check({ name: "laptop", expiresInDays: 0 })).not.toEqual([]);

    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "afternoon", 30);
    const expiresAt = new Date(minted.expiresAt ?? 0).getTime();
    const expected = expiryFrom(new Date(minted.createdAt), 30).getTime();
    // Within a second of the arithmetic the MCP keys use — the same function, so
    // "30 days" cannot come to mean two lengths in one product.
    expect(Math.abs(expiresAt - expected)).toBeLessThan(1000);
  });
});
