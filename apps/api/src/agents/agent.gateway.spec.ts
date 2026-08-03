import { beforeEach, describe, expect, it } from "@jest/globals";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { HttpAdapterHost } from "@nestjs/core";
import { AGENT_KEY_HEADER } from "@pdmux/protocol";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostService } from "../hosts/host-service.entity";
import { HostGitRootsService } from "../hosts/host-git-roots.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostServicesService } from "../hosts/host-services.service";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentAckService } from "./agent-ack.service";
import { AgentAuthFailure } from "./agent-auth-failure.entity";
import { AgentAuthFailuresService } from "./agent-auth-failures.service";
import { AgentConfigService } from "./agent-config.service";
import { AgentDisconnectService } from "./agent-disconnect.service";
import { AgentGateway } from "./agent.gateway";
import { AgentIngestService } from "./agent-ingest.service";
import { AgentRegistryService } from "./agent-registry.service";
import { AgentToken } from "./agent-token.entity";
import { AgentTokensService } from "./agent-tokens.service";
import {
  VERIFY_DIALS_PER_WINDOW,
  VerifyDialBudget,
  isVerifyDial,
} from "./agent-verify";

const ORG = "org-a";

/** A socket that records what the gateway did to it. */
class FakeSocket {
  readonly sent: unknown[] = [];
  readonly listeners: string[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  on(event: string): this {
    this.listeners.push(event);
    return this;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/**
 * An upgrade the gateway can refuse. Only the two fields the ladder reads.
 *
 * `x-forwarded-for` is present because that is what actually arrives here — the web
 * tier rewrites it and Express `trust proxy` is off, so the header is the caller's
 * address and `socket.remoteAddress` is the proxy's (`common/client-ip.ts`).
 */
function upgrade(key?: string, forwardedFor = "203.0.113.7"): IncomingMessage {
  return {
    url: "/agent/ws",
    headers: {
      ...(key === undefined ? {} : { [AGENT_KEY_HEADER]: key }),
      "x-forwarded-for": forwardedFor,
    },
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as IncomingMessage;
}

/** Records the HTTP status the refusal wrote, without a real socket. */
class FakeDuplex {
  written = "";
  destroyed = false;

  write(text: string): boolean {
    this.written += text;
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** e.g. `401`, or null when nothing was written. */
  get status(): number | null {
    const match = /^HTTP\/1\.1 (\d{3})/.exec(this.written);
    return match?.[1] ? Number(match[1]) : null;
  }

  asDuplex(): Duplex {
    return this as unknown as Duplex;
  }
}

async function build(): Promise<{
  gateway: AgentGateway;
  hosts: HostsService;
  registry: AgentRegistryService;
  tokens: FakeRepository<AgentToken>;
  tokensService: AgentTokensService;
  failures: FakeRepository<AgentAuthFailure>;
  host: Host;
  tokenId: string;
  token: string;
}> {
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
  const services = new HostServicesService(serviceRepo.asRepository(), hosts);
  const gitRoots = new HostGitRootsService(gitRootRepo.asRepository(), hosts);
  const tokenRows = new FakeRepository<AgentToken>({ lastUsedAt: null, revokedAt: null, createdAt: new Date() });
  const registry = new AgentRegistryService();
  const tokens = new AgentTokensService(
    tokenRows.asRepository(),
    hosts,
    new AgentDisconnectService(hosts, registry),
  );
  const ack = { ackAllRepos: async (): Promise<number> => 0 };
  const failureRows = new FakeRepository<AgentAuthFailure>({ count: 1 });
  const gateway = new AgentGateway(
    // No HTTP server is mounted in a unit test; the accept path does not need one.
    { httpAdapter: undefined } as unknown as HttpAdapterHost,
    tokens,
    hosts,
    new AgentConfigService(settings, services, gitRoots),
    { handle: async (): Promise<{ ok: true; type: "pong" }> => ({ ok: true, type: "pong" }) } as unknown as AgentIngestService,
    registry,
    ack as unknown as AgentAckService,
    new AgentAuthFailuresService(failureRows.asRepository(), hosts),
  );

  const host = await hosts.create(ORG, { label: "build-01" });
  const minted = await tokens.mint(ORG, host.id, "laptop");
  return {
    gateway,
    hosts,
    registry,
    tokens: tokenRows,
    tokensService: tokens,
    failures: failureRows,
    host,
    tokenId: minted.id,
    token: minted.token,
  };
}

describe("[TC-PDAGENT-065] a verify dial does not register, evict or stamp the host", () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  it("selects the mode on the exact query value only", () => {
    expect(isVerifyDial(new URLSearchParams("mode=verify"))).toBe(true);
    expect(isVerifyDial(new URLSearchParams("token=x&mode=verify"))).toBe(true);
    // Anything else is a normal connection: a typo that silently produced an
    // unregistered socket would look like an agent that connects and never appears.
    expect(isVerifyDial(new URLSearchParams(""))).toBe(false);
    expect(isVerifyDial(new URLSearchParams("mode=Verify"))).toBe(false);
    expect(isVerifyDial(new URLSearchParams("mode=verifying"))).toBe(false);
    expect(isVerifyDial(new URLSearchParams("verify=1"))).toBe(false);
  });

  it("leaves the live agent's socket attached and its PTYs alive", async () => {
    const live = new FakeSocket();
    await ctx.gateway.accept(live.asWebSocket(), {
      hostId: ctx.host.id,
      organizationId: ORG,
      tokenId: ctx.tokenId,
      tokenExpiresAt: null,
      verify: false,
    });
    expect(ctx.registry.isConnected(ctx.host.id)).toBe(true);

    const evictions: string[] = [];
    ctx.registry.onHostDisconnect((hostId, reason) => evictions.push(`${hostId}:${reason}`));

    const candidate = new FakeSocket();
    await ctx.gateway.accept(candidate.asWebSocket(), {
      hostId: ctx.host.id,
      organizationId: ORG,
      tokenId: ctx.tokenId,
      tokenExpiresAt: null,
      verify: true,
    });

    // The whole point: no `replaced` disconnect, and the registry still points at
    // the running agent — a candidate that evicted it would kill every open pane.
    expect(evictions).toEqual([]);
    expect(ctx.registry.isConnected(ctx.host.id)).toBe(true);
    expect(ctx.registry.sendToHost(ctx.host.id, { type: "ping", ts: 1 })).toBe(true);
    expect(live.sent).toHaveLength(2); // welcome + the ping just relayed
    expect(candidate.sent).toHaveLength(1);
  });

  it("answers with a welcome and hangs up, without an ingest path", async () => {
    const candidate = new FakeSocket();
    await ctx.gateway.accept(candidate.asWebSocket(), {
      hostId: ctx.host.id,
      organizationId: ORG,
      tokenId: ctx.tokenId,
      tokenExpiresAt: null,
      verify: true,
    });

    // A real welcome, because that is exactly the bar the candidate has to clear.
    expect(candidate.sent[0]).toMatchObject({ type: "welcome", hostId: ctx.host.id });
    expect(candidate.closed).toEqual({ code: 1000, reason: "verify complete" });
    // No `message` listener: frames from a verify socket reach no ingest at all.
    expect(candidate.listeners).toEqual(["error"]);
  });

  it("writes nothing to the host row", async () => {
    const before = await ctx.hosts.get(ORG, ctx.host.id);
    expect(before.lastSeenAt).toBeUndefined();

    const candidate = new FakeSocket();
    await ctx.gateway.accept(candidate.asWebSocket(), {
      hostId: ctx.host.id,
      organizationId: ORG,
      tokenId: ctx.tokenId,
      tokenExpiresAt: null,
      verify: true,
    });

    const after = await ctx.hosts.get(ORG, ctx.host.id);
    expect(after.lastSeenAt).toBeUndefined();
    expect(after.agentVersion).toBeUndefined();
    expect(after.lastUpdate).toBeUndefined();
  });

  it("still stamps the token, because the mode is the caller's to choose", async () => {
    const candidate = new FakeSocket();
    await ctx.gateway.accept(candidate.asWebSocket(), {
      hostId: ctx.host.id,
      organizationId: ORG,
      tokenId: ctx.tokenId,
      tokenExpiresAt: null,
      verify: true,
    });

    // `lastUsedAt` is credential evidence, and a flag the client sets must not be
    // able to hide a use of a stolen key.
    const row = ctx.tokens.rows.find((candidateRow) => candidateRow.id === ctx.tokenId);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("budgets verify dials per host, and only verify dials", () => {
    const budget = new VerifyDialBudget();
    const now = Date.now();
    for (let attempt = 0; attempt < VERIFY_DIALS_PER_WINDOW; attempt += 1) {
      expect(budget.allow("host-a", now)).toBe(true);
    }
    expect(budget.allow("host-a", now)).toBe(false);
    // One host's loop must not stop another's update.
    expect(budget.allow("host-b", now)).toBe(true);
    // The window slides: an hour later the budget is whole again.
    expect(budget.allow("host-a", now + 60 * 60_000)).toBe(true);
  });
});

/**
 * The ladder in `authorizeAndAccept` used to answer 401/403 and record NOTHING —
 * only the 429 branch logged. An agent whose host had been deleted, or whose token
 * somebody revoked, retried forever and left no trace an administrator could find.
 */
describe("[TC-PDADMIN-051] every refusal is recorded, and every refusal stays opaque", () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  /**
   * Runs the real ladder and hands back what the socket was told.
   *
   * ⚠ THE FLUSH IS NOT PADDING. The ladder deliberately does NOT await its own
   * bookkeeping — a write on the path a machine retries forever must not be able to
   * hold up (or fail) a refusal — so the row lands a microtask later than the
   * rejection. Without this the spec would read an empty table and, worse, would
   * pass or fail depending on how many awaits happened to follow it.
   */
  async function refuse(key?: string, forwardedFor?: string): Promise<FakeDuplex> {
    const socket = new FakeDuplex();
    await ctx.gateway.authorizeAndAccept(
      upgrade(key, forwardedFor),
      socket.asDuplex(),
      Buffer.alloc(0),
    );
    await new Promise((resolve) => setImmediate(resolve));
    return socket;
  }

  it("names each rung: missing, unknown, revoked, deleted host, disabled host", async () => {
    await refuse(); // no header at all
    await refuse("pdmux_not-a-token-anybody-ever-minted");

    const revoked = await ctx.tokensService.mint(ORG, ctx.host.id, "old");
    await ctx.tokensService.revoke(ORG, ctx.host.id, revoked.id);
    await refuse(revoked.token);

    await ctx.hosts.update(ORG, ctx.host.id, { enabled: false });
    await refuse(ctx.token);

    const recorded = ctx.failures.rows.map((row) => ({ reason: row.reason, hostId: row.hostId }));
    expect(recorded).toEqual([
      { reason: "missing_key", hostId: null },
      // Nothing was found, so there is no host to name.
      { reason: "unknown", hostId: null },
      // These two DO name one, which is what turns a wall of refusals into
      // "build-01 is still dialling with the token you revoked".
      { reason: "revoked", hostId: ctx.host.id },
      { reason: "host_disabled", hostId: ctx.host.id },
    ]);
  });

  it("records an expired token as expired, without anybody having revoked it", async () => {
    const minted = await ctx.tokensService.mint(ORG, ctx.host.id, "afternoon", 7);
    const row = ctx.tokens.rows.find((candidate) => candidate.id === minted.id);
    expect(row).toBeDefined();
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    const socket = await refuse(minted.token);

    expect(socket.status).toBe(401);
    expect(ctx.failures.rows.map((entry) => entry.reason)).toEqual(["expired"]);
    expect(ctx.failures.rows[0]?.hostId).toBe(ctx.host.id);
  });

  it("answers the same opaque status for missing, unknown, revoked and expired", async () => {
    const revoked = await ctx.tokensService.mint(ORG, ctx.host.id, "old");
    await ctx.tokensService.revoke(ORG, ctx.host.id, revoked.id);
    const expired = await ctx.tokensService.mint(ORG, ctx.host.id, "afternoon", 7);
    const expiredRow = ctx.tokens.rows.find((candidate) => candidate.id === expired.id);
    if (expiredRow) expiredRow.expiresAt = new Date(Date.now() - 1000);

    const statuses = [];
    for (const key of [undefined, "pdmux_nobody-minted-this-one-ever", revoked.token, expired.token]) {
      const socket = await refuse(key);
      statuses.push(socket.status);
      // The body says nothing either: a reason on the wire is an oracle telling an
      // attacker which guesses were once real, and when a real one lapsed.
      expect(socket.written).not.toMatch(/revoked|expired|unknown/i);
      expect(socket.destroyed).toBe(true);
    }
    expect(statuses).toEqual([401, 401, 401, 401]);
  });

  it("records the caller's address, not the web tier's", async () => {
    // `socket.remoteAddress` is 10.0.0.1 in this fixture — the proxy. Recording that
    // would put every refusal in the fleet under one address.
    await refuse(undefined, "198.51.100.42");
    expect(ctx.failures.rows[0]?.sourceIp).toBe("198.51.100.42");
  });

  it("never stores the secret that was presented", async () => {
    const revoked = await ctx.tokensService.mint(ORG, ctx.host.id, "old");
    await ctx.tokensService.revoke(ORG, ctx.host.id, revoked.id);
    await refuse(revoked.token);

    // Not the plaintext, and not a masked fragment of it either: a table of nearly
    // valid material is a target, and most refused secrets are real revoked tokens.
    const stored = JSON.stringify(ctx.failures.rows);
    expect(stored).not.toContain(revoked.token);
    expect(stored).not.toContain(revoked.token.slice(-8));
  });
});
