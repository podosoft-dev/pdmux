import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BadRequestException, ForbiddenException, Logger, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import "reflect-metadata";
import type { UserSession } from "@thallesp/nestjs-better-auth";
import { AppException } from "../common/app-exception";
import { AUDIT_KEY, type AuditMeta } from "../audit/audit.decorator";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsController } from "../hosts/hosts.controller";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentEnrollment } from "./agent-enrollment.entity";
import { AgentEnrollmentsController } from "./agent-enrollments.controller";
import { AgentEnrollmentsService, ENROLLMENT_TTL_MS } from "./agent-enrollments.service";
import { AgentToken } from "./agent-token.entity";
import { AgentDisconnectService } from "./agent-disconnect.service";
import { AgentRegistryService } from "./agent-registry.service";
import { AgentTokensService } from "./agent-tokens.service";
import { mintEnrollmentCode } from "./agent-enrollment.crypto";
import { EnrollAgentDto } from "./dto/enroll-agent.dto";

const ORG_A = "org-a";
const ORG_B = "org-b";
const IP = "203.0.113.7";

/** Enrollment never revokes anything, so the disconnect path is inert here —
 *  what a revocation does to a live socket is TC-PDAGENT-075. */
function agentTokens(rows: FakeRepository<AgentToken>, hosts: HostsService): AgentTokensService {
  return new AgentTokensService(
    rows.asRepository(),
    hosts,
    new AgentDisconnectService(hosts, new AgentRegistryService()),
  );
}

function build(): {
  enrollments: AgentEnrollmentsService;
  hosts: HostsService;
  hostRepo: FakeRepository<Host>;
  rows: FakeRepository<AgentEnrollment>;
  tokenRows: FakeRepository<AgentToken>;
} {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(hostRepo.asRepository(), serviceRepo.asRepository(), gitRootRepo.asRepository(), settings, fakeAgentReleases(), fakeDataSource());
  const tokenRows = new FakeRepository<AgentToken>({ lastUsedAt: null, revokedAt: null, createdAt: new Date() });
  const tokens = agentTokens(tokenRows, hosts);
  const rows = new FakeRepository<AgentEnrollment>({
    consumedAt: null,
    consumedIp: null,
    revokedAt: null,
    tokenId: null,
    createdByUserId: null,
    createdAt: new Date(),
  });
  return {
    enrollments: new AgentEnrollmentsService(rows.asRepository(), hosts, tokens),
    hosts,
    hostRepo,
    rows,
    tokenRows,
  };
}

function session(role: string): UserSession {
  return {
    user: { id: "user-1", name: "Ada", email: "ada@example.com", role },
    session: { activeOrganizationId: ORG_A },
  } as unknown as UserSession;
}

/** Reach into a stored row to age it, the way 15 minutes of wall clock would. */
function expire(row: AgentEnrollment): void {
  row.expiresAt = new Date(Date.now() - 1000);
}

describe("[TC-PDAGENT-063] enrollment code lifecycle", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("returns the plaintext exactly once and stores only its hash", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    expect(minted.code).toMatch(/^pdmxe_/);
    expect(minted.status).toBe("live");
    expect(minted.expiresInSec).toBeGreaterThan(ENROLLMENT_TTL_MS / 1000 - 5);
    expect(minted.masked).not.toContain(minted.code.slice(-10));

    // Not in the row...
    expect(JSON.stringify(ctx.rows.rows)).not.toContain(minted.code);
    // ...and not in any later read. The code exists in exactly one response body.
    const current = await ctx.enrollments.current(ORG_A, host.id);
    expect(JSON.stringify(current)).not.toContain(minted.code);
    expect(current).not.toHaveProperty("code");
    expect(current?.id).toBe(minted.id);
    expect(current?.status).toBe("live");
  });

  it("hands a live code over with the host, in one call", async () => {
    // The wiring `POST /hosts` rides on: this service registers itself as the
    // issuer, so the hosts side never has to import it back.
    ctx.enrollments.onModuleInit();
    const controller = new HostsController(ctx.hosts);

    const created = await controller.create(session("admin"), { label: "build-01" });

    const code = created.enrollment?.code ?? "";
    expect(code).toMatch(/^pdmxe_/);
    // It is this host's live code, not a decoration — `current` reports the same
    // row, and (still) without the plaintext anywhere in it.
    const current = await ctx.enrollments.current(ORG_A, created.id);
    expect(current).toMatchObject({ id: created.enrollment?.id, hostId: created.id, status: "live" });
    expect(JSON.stringify(current)).not.toContain(code);
    // The session's user is recorded as the issuer, exactly as a manual mint does.
    expect((ctx.rows.rows[0] as { createdByUserId?: string }).createdByUserId).toBe("user-1");
    // And an installer can spend it: registration alone now enrols a machine.
    await expect(ctx.enrollments.redeem(code, IP)).resolves.toMatchObject({ hostId: created.id });

    // The audit entry records THAT a code was issued and which row it is — never
    // the plaintext, which exists in that one response body and nowhere else.
    const handler = (HostsController.prototype as unknown as Record<string, () => unknown>).create;
    const audit = Reflect.getMetadata(AUDIT_KEY, handler) as AuditMeta | undefined;
    expect(audit?.action).toBe("host.create");
    const target = audit?.resolve?.({} as never, created);
    expect(JSON.stringify(target ?? {})).not.toContain(code);
    expect(target?.metadata).toEqual({ enrollmentIssued: true, enrollmentId: created.enrollment?.id });
  });

  it("registers the host even when its code cannot be minted", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    ctx.enrollments.onModuleInit();
    // The one failure the mint has of its own: two clicks landing together lose to
    // the partial unique index (surfaced as ENROLL_CODE_CONFLICT).
    const save = ctx.rows.save.bind(ctx.rows);
    ctx.rows.save = (): never => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    };

    const created = await new HostsController(ctx.hosts).create(session("admin"), { label: "build-01" });

    expect(created.enrollment).toBeNull();
    expect(await ctx.hosts.get(ORG_A, created.id)).toMatchObject({ label: "build-01" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without an enrollment code"));

    // The escape hatch is the endpoint that already exists — one click, no lost host.
    ctx.rows.save = save;
    await expect(ctx.enrollments.create(ORG_A, created.id, "user-1")).resolves.toMatchObject({ status: "live" });
    warn.mockRestore();
  });

  it("keeps at most one live code per host: creating again retires the previous one", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const first = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    const second = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    expect(second.code).not.toBe(first.code);
    const live = ctx.rows.rows.filter((row) => row.consumedAt === null && row.revokedAt === null);
    expect(live).toHaveLength(1);
    expect((live[0] as { id: string }).id).toBe(second.id);

    // The retired code is dead immediately — a screenshot of it buys nothing.
    await expect(ctx.enrollments.redeem(first.code, IP)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.enrollments.redeem(second.code, IP)).resolves.toMatchObject({ hostId: host.id });
  });

  it("reports the state of an expired code so an operator can see what happened", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    expire(ctx.rows.rows[0] as unknown as AgentEnrollment);

    const current = await ctx.enrollments.current(ORG_A, host.id);
    expect(current).toMatchObject({ id: minted.id, status: "expired", expiresInSec: 0 });
  });

  it("revokes idempotently and hides the row from `current`", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    const revoked = await ctx.enrollments.revoke(ORG_A, host.id, minted.id);
    expect(revoked.status).toBe("revoked");
    expect(await ctx.enrollments.current(ORG_A, host.id)).toBeNull();

    const again = await ctx.enrollments.revoke(ORG_A, host.id, minted.id);
    expect(again.revokedAt).toBe(revoked.revokedAt);
  });

  it("keeps codes inside their host's organization", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    await expect(ctx.enrollments.create(ORG_B, host.id, "intruder")).rejects.toBeInstanceOf(AppException);
    await expect(ctx.enrollments.current(ORG_B, host.id)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.enrollments.revoke(ORG_B, host.id, minted.id)).rejects.toBeInstanceOf(AppException);

    // Untouched by the failed attempts.
    await expect(ctx.enrollments.redeem(minted.code, IP)).resolves.toMatchObject({ hostId: host.id });
  });

  it("translates the live-code unique index into a 409 rather than a driver error", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const rows = ctx.rows;
    rows.save = (): never => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    };
    const service = new AgentEnrollmentsService(
      rows.asRepository(),
      ctx.hosts,
      agentTokens(ctx.tokenRows, ctx.hosts),
    );

    await expect(service.create(ORG_A, host.id, "user-1")).rejects.toMatchObject({
      code: "ENROLL_CODE_CONFLICT",
      statusCode: 409,
    });
  });

  it("is admin-only and audited on every mutation", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const controller = new AgentEnrollmentsController(ctx.enrollments);

    // assertCanManageFleet throws before the handler returns a promise, so these are
    // synchronous throws — a non-admin never reaches the service at all.
    expect(() => controller.create(session("user"), host.id, {})).toThrow(ForbiddenException);
    // ⚠ Express 5 leaves `req.body` UNDEFINED for a bodyless POST (Express 4 left
    // `{}`), and this route took no body until the expiry choice arrived — so an
    // un-updated caller must still get a code, not a 500 off a missing property.
    expect(() => controller.create(session("user"), host.id, undefined)).toThrow(ForbiddenException);
    expect(() => controller.current(session("user"), host.id)).toThrow(ForbiddenException);
    expect(() => controller.revoke(session("user"), host.id, host.id)).toThrow(ForbiddenException);

    const minted = await controller.create(session("admin"), host.id, undefined);
    expect(minted.code).toMatch(/^pdmxe_/);
    // The session's user is recorded as the issuer.
    expect((ctx.rows.rows[0] as { createdByUserId?: string }).createdByUserId).toBe("user-1");

    const prototype = AgentEnrollmentsController.prototype as unknown as Record<string, () => unknown>;
    for (const name of ["create", "revoke"]) {
      const handler = prototype[name] as () => unknown;
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
      const audit = Reflect.getMetadata(AUDIT_KEY, handler) as AuditMeta | undefined;
      expect(audit?.action).toBe(`agent.enrollment.${name === "create" ? "create" : "revoke"}`);
      // ...and the audit target never carries the plaintext.
      expect(JSON.stringify(audit?.resolve?.({} as never, minted) ?? {})).not.toContain(minted.code);
    }
  });
});

describe("[TC-PDAGENT-064] enrollment code redemption", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("trades a code for a fresh token and records who took it", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    const enrolled = await ctx.enrollments.redeem(minted.code, IP);
    expect(enrolled).toMatchObject({ hostId: host.id, hostLabel: "build-01" });
    expect(enrolled.token).toMatch(/^pdmux_/);
    expect(enrolled.tokenName).toMatch(/^installer \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    expect(enrolled.tokenName.length).toBeLessThanOrEqual(64);

    // The minted token is a real, live host token.
    expect((await agentTokens(ctx.tokenRows, ctx.hosts).resolve(enrolled.token))?.hostId).toBe(
      host.id,
    );

    const row = ctx.rows.rows[0] as unknown as AgentEnrollment;
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedIp).toBe(IP);
    expect(row.tokenId).toBe(enrolled.tokenId);
    // The code itself never lands in the row, even after redemption.
    expect(JSON.stringify(row)).not.toContain(minted.code);
  });

  it("accepts the code however it was retyped", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    // Lower case, no dashes, padded — the same code, so the same row.
    const retyped = ` ${minted.code.replace(/-/g, "").toLowerCase()} `;
    await expect(ctx.enrollments.redeem(retyped, IP)).resolves.toMatchObject({ hostId: host.id });
  });

  it("is single-use even when two installers redeem at the same instant", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    const results = await Promise.allSettled([
      ctx.enrollments.redeem(minted.code, "203.0.113.1"),
      ctx.enrollments.redeem(minted.code, "203.0.113.2"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    // Exactly one token exists — the loser minted nothing.
    expect(ctx.tokenRows.rows).toHaveLength(1);

    // And it stays spent afterwards.
    await expect(ctx.enrollments.redeem(minted.code, IP)).rejects.toMatchObject({ code: "ENROLL_CODE_INVALID" });
  });

  it("refuses an expired code without minting anything", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    expire(ctx.rows.rows[0] as unknown as AgentEnrollment);

    await expect(ctx.enrollments.redeem(minted.code, IP)).rejects.toMatchObject({ code: "ENROLL_CODE_INVALID" });
    expect(ctx.tokenRows.rows).toHaveLength(0);
    expect((ctx.rows.rows[0] as { consumedAt: Date | null }).consumedAt).toBeNull();
  });

  it("refuses a revoked code", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    await ctx.enrollments.revoke(ORG_A, host.id, minted.id);

    await expect(ctx.enrollments.redeem(minted.code, IP)).rejects.toMatchObject({ code: "ENROLL_CODE_INVALID" });
    expect(ctx.tokenRows.rows).toHaveLength(0);
  });

  it("answers a disabled host with 409 and does NOT consume the code", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    await ctx.hosts.setEnabled(ORG_A, host.id, false);

    await expect(ctx.enrollments.redeem(minted.code, IP)).rejects.toMatchObject({
      code: "HOST_DISABLED",
      statusCode: 409,
    });
    expect((ctx.rows.rows[0] as { consumedAt: Date | null }).consumedAt).toBeNull();
    expect(ctx.tokenRows.rows).toHaveLength(0);

    // One toggle, and the same code still works — no second trip to the machine.
    await ctx.hosts.setEnabled(ORG_A, host.id, true);
    await expect(ctx.enrollments.redeem(minted.code, IP)).resolves.toMatchObject({ hostId: host.id });
  });

  it("never touches the host's existing tokens", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const tokens = agentTokens(ctx.tokenRows, ctx.hosts);
    const existing = await tokens.mint(ORG_A, host.id, "laptop");
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");

    await ctx.enrollments.redeem(minted.code, IP);

    // A 15-minute code must not be able to kick a live agent off its socket, and
    // an in-place upgrade re-enrols legitimately.
    expect((await tokens.resolve(existing.token))?.hostId).toBe(host.id);
    expect(await tokens.list(ORG_A, host.id)).toHaveLength(2);
  });

  it("answers every failure with the same opaque 401", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const consumed = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    await ctx.enrollments.redeem(consumed.code, IP);

    const unknown = mintEnrollmentCode().code; // well-formed, never issued
    const revokedHost = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const revoked = await ctx.enrollments.create(ORG_A, revokedHost.id, "user-1");
    await ctx.enrollments.revoke(ORG_A, revokedHost.id, revoked.id);

    const attempts = ["", "garbage", "pdmux_looks-like-a-token", unknown, consumed.code, revoked.code];
    for (const attempt of attempts) {
      const error = await ctx.enrollments.redeem(attempt, IP).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppException);
      // Same code, same status, same message: malformed, unknown, expired,
      // consumed and revoked are indistinguishable to whoever is spraying codes.
      expect({
        attempt,
        code: (error as AppException).code,
        status: (error as AppException).statusCode,
        message: (error as AppException).message,
      }).toEqual({
        attempt,
        code: "ENROLL_CODE_INVALID",
        status: 401,
        message: "Enrollment code is not valid",
      });
    }
  });

  it("takes the code in the body, and treats an undeclared field as a 400", async () => {
    // The same pipe main.ts installs globally.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta = { type: "body" as const, metatype: EnrollAgentDto, data: "" };
    const code = "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW";

    await expect(
      pipe.transform({ code, hostname: "build-01", os: "linux", arch: "amd64", agentVersion: "0.2.0" }, meta),
    ).resolves.toMatchObject({ code, hostname: "build-01" });

    // ⚠ Why the code cannot ride in a header: the web proxy forwards a fixed
    // allowlist (backend-proxy.ts) and a custom header never arrives — so a body
    // with no `code` is what the API would see, and this is that error.
    await expect(pipe.transform({ hostname: "build-01" }, meta)).rejects.toBeInstanceOf(BadRequestException);

    // ⚠ forbidNonWhitelisted: an unknown property is a 400, not a silent drop.
    // A newer installer that sends one more field breaks against an older API.
    await expect(pipe.transform({ code, kernel: "6.8.0" }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not touch the database for a malformed code", async () => {
    const rows = ctx.rows;
    let reads = 0;
    const findOne = rows.findOne.bind(rows);
    rows.findOne = async (args): Promise<AgentEnrollment | null> => {
      reads += 1;
      return findOne(args);
    };

    await expect(ctx.enrollments.redeem("nonsense", IP)).rejects.toBeInstanceOf(AppException);
    expect(reads).toBe(0);
  });
});

/**
 * The installer's one-liner is how most agents get their credential, so an expiry
 * that only `POST /hosts/:id/tokens` could set would be an expiry almost nothing
 * uses. The choice is recorded on the CODE — by whoever issues it — because the
 * party redeeming is the machine being enrolled, and a machine asked how long its
 * own credential should last answers "forever".
 */
describe("[TC-PDAGENT-068] the expiry chosen at issue survives the exchange", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("carries the operator's choice from the code onto the token it buys", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1", 7);
    expect(ctx.rows.rows[0]?.tokenExpiresInDays).toBe(7);

    await ctx.enrollments.redeem(minted.code, IP);

    const token = ctx.tokenRows.rows[0] as unknown as AgentToken;
    expect(token.expiresAt).toBeInstanceOf(Date);
    const days = ((token.expiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("defaults to never, so an ordinary install is unchanged", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1");
    expect(ctx.rows.rows[0]?.tokenExpiresInDays).toBeNull();

    await ctx.enrollments.redeem(minted.code, IP);
    expect((ctx.tokenRows.rows[0] as unknown as AgentToken).expiresAt).toBeNull();
  });

  it("does not let the redeeming machine choose its own lifetime", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.enrollments.create(ORG_A, host.id, "user-1", 7);

    // `redeem` takes a code and an address and nothing else — there is no argument
    // an installer could send to widen this, which is the point of parking the
    // number on the row rather than asking for it at redemption.
    await ctx.enrollments.redeem(minted.code, IP);
    const token = ctx.tokenRows.rows[0] as unknown as AgentToken;
    expect(token.expiresAt).toBeInstanceOf(Date);
    expect((token.expiresAt as Date).getTime()).toBeLessThan(Date.now() + 8 * 86_400_000);
  });
});
