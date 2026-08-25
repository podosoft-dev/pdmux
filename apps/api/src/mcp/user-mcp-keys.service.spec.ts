import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import "reflect-metadata";
import type { DataSource } from "typeorm";

import { AppException } from "../common/app-exception";
import { FakeRepository } from "../testing/fake-repository";
import { McpAuthorityService } from "./mcp-authority.service";
import { UserMcpKey } from "./user-mcp-key.entity";
import { MCP_TOKEN_PREFIX, looksLikeMcpToken } from "./user-mcp-key.crypto";
import { MCP_KEY_PREFIX, looksLikeMcpKey, mintMcpKey } from "./host-mcp-key.crypto";
import { UserMcpKeysService } from "./user-mcp-keys.service";

const ORG = "org-a";
const USER = "user-1";

/**
 * A stand-in for the better-auth tables `McpAuthorityService` reads. Owning no user
 * entity is the whole reason that service uses raw SQL, so the fake answers SQL
 * rather than pretending there is a repository.
 */
function fakeAuthDataSource(world: {
  users?: Record<string, { role?: string | null; banned?: boolean; banExpires?: Date | null }>;
  members?: [userId: string, organizationId: string][];
}): DataSource {
  const users = world.users ?? {};
  const members = new Set((world.members ?? []).map(([u, o]) => `${u} ${o}`));
  return {
    query: async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('FROM "user"')) {
        const row = users[String(parameters?.[0])];
        return row ? [{ role: row.role ?? null, banned: row.banned ?? false, banExpires: row.banExpires ?? null }] : [];
      }
      if (sql.includes('FROM "member"')) {
        return members.has(`${String(parameters?.[0])} ${String(parameters?.[1])}`) ? [{ "?column?": 1 }] : [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DataSource;
}

function context(world: Parameters<typeof fakeAuthDataSource>[0]) {
  const rows = new FakeRepository<UserMcpKey>({ lastUsedAt: null, revokedAt: null, createdAt: new Date() });
  const authority = new McpAuthorityService(fakeAuthDataSource(world));
  const tokens = new UserMcpKeysService(rows.asRepository(), authority);
  return { tokens, rows, authority };
}

/** An app admin in an organization: the only shape that may grant every tier. */
const adminWorld = { users: { [USER]: { role: "admin" } }, members: [[USER, ORG] as [string, string]] };
/** An ordinary member of the same organization. */
const memberWorld = { users: { [USER]: { role: "user" } }, members: [[USER, ORG] as [string, string]] };

const mintInput = { label: "my laptop", expiresInDays: 90 as const, tier: "operate" as const };

describe("[TC-PDMCP-052] a fleet token is shown once and stored as a hash", () => {
  let ctx: ReturnType<typeof context>;
  beforeEach(() => {
    ctx = context(adminWorld);
  });

  it("returns the plaintext exactly once, and never stores it", async () => {
    const minted = await ctx.tokens.mint(ORG, USER, mintInput);

    expect(minted.token.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    const stored = ctx.rows.rows[0];
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(minted.token);
    expect(stored?.keyHash).not.toBe(minted.token);

    const listed = await ctx.tokens.list(ORG, USER);
    expect(JSON.stringify(listed)).not.toContain(minted.token);
    // The prefix is the only part that survives, and it names a row without
    // reconstructing anything.
    expect(listed[0]?.keyPrefix.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
  });

  /**
   * ⚠ BOTH DIRECTIONS. A prefix that merely *starts differently* is not enough —
   * `pdmux_mcpu_` would have satisfied `looksLikeMcpKey` and been looked up in the
   * wrong table. The pair has to be mutually exclusive so authentication can dispatch
   * on shape before touching the database.
   */
  it("cannot be mistaken for a host key, in either direction", async () => {
    const fleetToken = (await ctx.tokens.mint(ORG, USER, mintInput)).token;
    const hostKey = mintMcpKey().key;

    expect(looksLikeMcpToken(fleetToken)).toBe(true);
    expect(looksLikeMcpKey(fleetToken)).toBe(false);
    expect(looksLikeMcpKey(hostKey)).toBe(true);
    expect(looksLikeMcpToken(hostKey)).toBe(false);
    expect(MCP_TOKEN_PREFIX.startsWith(MCP_KEY_PREFIX)).toBe(false);
    expect(MCP_KEY_PREFIX.startsWith(MCP_TOKEN_PREFIX)).toBe(false);
  });
});

describe("[TC-PDMCP-052] the tier a person may grant is capped by their own authority", () => {
  it("lets an administrator grant every tier", async () => {
    const ctx = context(adminWorld);
    for (const tier of ["read", "operate", "admin"] as const) {
      await expect(ctx.tokens.mint(ORG, USER, { ...mintInput, tier })).resolves.toMatchObject({ tier });
    }
  });

  it("lets a sole owner of a personal fleet grant every tier", async () => {
    const ctx = context({ users: { [USER]: { role: "user" } } });
    await expect(
      ctx.tokens.mint(`personal:${USER}`, USER, { ...mintInput, tier: "admin" }),
    ).resolves.toMatchObject({ tier: "admin" });
  });

  /**
   * ⚠ THE PRIVILEGE-ESCALATION CASE. This person cannot rename a host in the
   * dashboard (`assertCanManageFleet` refuses them); a token that could would make
   * MCP a way around the UI's own permission model.
   */
  it("refuses an ordinary member anything above read", async () => {
    const ctx = context(memberWorld);
    await expect(ctx.tokens.mint(ORG, USER, { ...mintInput, tier: "operate" })).rejects.toBeInstanceOf(AppException);
    await expect(ctx.tokens.mint(ORG, USER, { ...mintInput, tier: "admin" })).rejects.toBeInstanceOf(AppException);
    // Read-only is still useful to them — "which of my machines is offline" needs no
    // authority at all — so it must not be refused too.
    await expect(ctx.tokens.mint(ORG, USER, { ...mintInput, tier: "read" })).resolves.toMatchObject({ tier: "read" });
  });

  it("refuses somebody with no standing in the scope at all", async () => {
    const ctx = context({ users: { [USER]: { role: "admin" } } }); // no membership row
    await expect(ctx.tokens.mint(ORG, USER, mintInput)).rejects.toBeInstanceOf(AppException);
  });
});

/**
 * ⚠ THE HIGHEST-VALUE TESTS IN THIS FILE.
 *
 * A token freezes the scope it was minted in; the person's standing in that scope is
 * not frozen with it. Everything here describes what happens AFTER the moment the
 * ceiling was first checked — which is the whole life of the credential.
 */
describe("[TC-PDMCP-053] authority is re-derived on every authentication", () => {
  async function mintedIn(world: Parameters<typeof fakeAuthDataSource>[0], tier: "read" | "operate" | "admin") {
    const ctx = context(adminWorld);
    const minted = await ctx.tokens.mint(ORG, USER, { ...mintInput, tier });
    // Re-point the same rows at a world where authority has since changed.
    const authority = new McpAuthorityService(fakeAuthDataSource(world));
    return { tokens: new UserMcpKeysService(ctx.rows.asRepository(), authority), token: minted.token };
  }

  it("weakens a token whose owner was demoted, rather than revoking it", async () => {
    const { tokens, token } = await mintedIn(memberWorld, "admin");

    const identity = await tokens.authenticate(token);

    // Still a working credential — losing a role is often transient, and revoking on
    // a transient condition is unrecoverable on re-promotion.
    expect(identity).not.toBeNull();
    // But it no longer carries what it was granted.
    expect(identity?.tier).toBe("admin");
    expect(identity?.effectiveTier).toBe("read");
  });

  it("refuses a token whose owner was removed from the organization", async () => {
    // The vulnerability this check exists for: the scope string is frozen into the
    // row, so without it a removed member keeps fleet-wide access until expiry.
    const { tokens, token } = await mintedIn({ users: { [USER]: { role: "admin" } } }, "admin");
    await expect(tokens.authenticate(token)).resolves.toBeNull();
  });

  it("refuses a token whose owner is banned, and honours a ban that has lapsed", async () => {
    const banned = await mintedIn(
      { users: { [USER]: { role: "admin", banned: true } }, members: [[USER, ORG]] },
      "operate",
    );
    await expect(banned.tokens.authenticate(banned.token)).resolves.toBeNull();

    const lapsed = await mintedIn(
      {
        users: { [USER]: { role: "admin", banned: true, banExpires: new Date(Date.now() - 60_000) } },
        members: [[USER, ORG]],
      },
      "operate",
    );
    // The column exists because bans are meant to lift; treating `banned` alone as
    // final reads as a broken token rather than a policy.
    await expect(lapsed.tokens.authenticate(lapsed.token)).resolves.not.toBeNull();
  });

  /**
   * The column is a `timestamptz` on a table another migrator owns, read through a
   * raw query. `pg` hands back a Date today; a driver or type-parser change that
   * handed back a string used to make the comparison throw, which fails the request
   * rather than the ban.
   */
  it("reads a ban deadline the driver gave it as text", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const lapsed = await mintedIn(
      { users: { [USER]: { role: "admin", banned: true, banExpires: past as unknown as Date } }, members: [[USER, ORG]] },
      "operate",
    );
    await expect(lapsed.tokens.authenticate(lapsed.token)).resolves.not.toBeNull();

    const future = new Date(Date.now() + 60_000).toISOString();
    const active = await mintedIn(
      { users: { [USER]: { role: "admin", banned: true, banExpires: future as unknown as Date } }, members: [[USER, ORG]] },
      "operate",
    );
    await expect(active.tokens.authenticate(active.token)).resolves.toBeNull();
  });

  /**
   * ⚠ "ON EVERY AUTHENTICATION" IS TRUE WITHIN A BOUND, AND THE BOUND IS THE POINT.
   *
   * The ceiling is cached for `McpAuthorityService.TTL_MS`, so a demotion takes
   * effect within that window rather than instantly — the same staleness the app
   * already accepts for `require2fa`, and the reason two database reads do not ride
   * on the highest-frequency authenticated surface in the product.
   *
   * Every other test here builds a fresh service, so none of them touch the cached
   * path: a cache keyed wrongly — on the user alone, say, so a second scope answered
   * with the first one's ceiling — would pass all of them.
   */
  it("serves a cached ceiling inside the window and a fresh one after it", async () => {
    const world = fakeAuthDataSource(adminWorld);
    const reads = spyOn(world, "query");
    const authority = new McpAuthorityService(world);

    expect(await authority.ceilingFor(USER, ORG)).toBe("admin");
    const afterFirst = reads.mock.calls.length;
    expect(await authority.ceilingFor(USER, ORG)).toBe("admin");
    expect(reads.mock.calls.length).toBe(afterFirst);

    // A DIFFERENT SCOPE IS A DIFFERENT ANSWER. Sharing an entry across scopes would
    // hand this caller the ceiling it holds somewhere else.
    expect(await authority.ceilingFor(USER, "org-other")).toBeNull();
    expect(reads.mock.calls.length).toBeGreaterThan(afterFirst);

    // Past the window it asks again — so a demotion lands, late but on its own.
    const later = Date.now() + 4_000;
    spyOn(Date, "now").mockReturnValue(later);
    try {
      const before = reads.mock.calls.length;
      await authority.ceilingFor(USER, ORG);
      expect(reads.mock.calls.length).toBeGreaterThan(before);
    } finally {
      spyOn(Date, "now").mockRestore();
    }
  });

  it("refuses a token whose owner no longer exists", async () => {
    const { tokens, token } = await mintedIn({}, "read");
    await expect(tokens.authenticate(token)).resolves.toBeNull();
  });
});

describe("[TC-PDMCP-053] a token reaches only its own scope and its own owner", () => {
  /**
   * ⚠ THE WRITE THAT MUST NOT BE ABLE TO KILL THE PROCESS. `lastUsedAt` is
   * bookkeeping — the read that decides the request already succeeded — but a bare
   * `void` on a rejected promise is an unhandled rejection, and node's default for
   * that is to terminate. So a blip on one non-essential column would take the API
   * down.
   */
  it("still authenticates when recording the use fails", async () => {
    const ctx = context(adminWorld);
    const minted = await ctx.tokens.mint(ORG, USER, mintInput);
    spyOn(ctx.rows, "update").mockRejectedValue(new Error("write timeout"));

    await expect(ctx.tokens.authenticate(minted.token)).resolves.not.toBeNull();
    // And the rejection was handled: an unhandled one fails the run on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("refuses an unrecognised, revoked or expired credential the same way", async () => {
    const ctx = context(adminWorld);
    const minted = await ctx.tokens.mint(ORG, USER, mintInput);

    await expect(ctx.tokens.authenticate("not-a-credential")).resolves.toBeNull();
    await expect(ctx.tokens.authenticate(`${MCP_TOKEN_PREFIX}${"x".repeat(30)}`)).resolves.toBeNull();
    await expect(ctx.tokens.authenticate(minted.token)).resolves.not.toBeNull();

    await ctx.tokens.revoke(ORG, USER, minted.id);
    await expect(ctx.tokens.authenticate(minted.token)).resolves.toBeNull();
  });

  it("stops on expiry with nobody revoking anything", async () => {
    const ctx = context(adminWorld);
    const minted = await ctx.tokens.mint(ORG, USER, mintInput);
    const row = ctx.rows.rows[0];
    expect(row).toBeDefined();
    if (row) row.expiresAt = new Date(Date.now() - 1_000);

    await expect(ctx.tokens.authenticate(minted.token)).resolves.toBeNull();
  });

  it("does not move the revocation timestamp when revoked twice", async () => {
    const ctx = context(adminWorld);
    const minted = await ctx.tokens.mint(ORG, USER, mintInput);

    const first = await ctx.tokens.revoke(ORG, USER, minted.id);
    const second = await ctx.tokens.revoke(ORG, USER, minted.id);

    // The timestamp is evidence of when access actually ended.
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it("does not list or revoke somebody else's token", async () => {
    const ctx = context(adminWorld);
    const minted = await ctx.tokens.mint(ORG, USER, mintInput);

    await expect(ctx.tokens.list(ORG, "user-2")).resolves.toEqual([]);
    await expect(ctx.tokens.revoke(ORG, "user-2", minted.id)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.tokens.revoke("org-b", USER, minted.id)).rejects.toBeInstanceOf(AppException);
  });
});
