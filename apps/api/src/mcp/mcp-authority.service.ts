import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { mcpCeilingFor, type ScopedSession } from "../fleet/session-scope";
import type { McpTier } from "./mcp-tier";

/**
 * What a token's owner is allowed to do RIGHT NOW.
 *
 * ⚠ THIS IS THE FILE THAT MAKES A LONG-LIVED TOKEN SAFE. A token freezes the scope
 * string it was minted in; the person's standing in that scope is not frozen with
 * it. Checking authority only at mint time means somebody removed from an
 * organization keeps fleet-wide access until the token expires — which for a
 * year-long token is a year. So the ceiling is recomputed on every authentication
 * and the effective tier is the minimum of it and what the row stores.
 *
 * ⚠ IT READS better-auth's TABLES DIRECTLY, and there is precedent:
 * `HostsService.resolveUserScope` does the same for the same reason. This module
 * owns no user entity — `user`, `member` and `organization` belong to better-auth
 * and its own migrator — and importing an entity across that boundary would couple
 * two release processes. A `SELECT` couples nothing.
 *
 * ⚠ DEMOTION IS A DOWNGRADE, NOT A REVOCATION. Losing authority is often transient
 * (a membership row missing mid-migration, a role being reshuffled), and revoking on
 * a transient condition is destructive and unrecoverable on re-promotion. A
 * downgraded token simply stops advertising the tools it can no longer use, which is
 * the clearest signal a model can get — `tools/list` is rebuilt per request from the
 * effective tier.
 */
/**
 * Has a ban's deadline already passed?
 *
 * No deadline means the ban does not lift. An unreadable one is treated as still in
 * force: the only two answers are "keep them out" and "let them in", and guessing
 * wrong in the second direction is the one that matters.
 */
function banHasLifted(banExpires: Date | string | null): boolean {
  if (banExpires === null) return false;
  const at = banExpires instanceof Date ? banExpires.getTime() : Date.parse(banExpires);
  return Number.isFinite(at) && at <= Date.now();
}

@Injectable()
export class McpAuthorityService {
  /**
   * Two queries per MCP request would be a real cost on the highest-frequency
   * authenticated surface in the product. Three seconds is the same staleness the
   * app already accepts for `require2fa`, and it is far shorter than the window in
   * which anybody notices a permission change.
   */
  private static readonly TTL_MS = 3_000;

  /** Only sweep once the map is big enough for sweeping to be worth a loop. */
  private static readonly SWEEP_AT = 64;

  private readonly cache = new Map<string, { at: number; ceiling: McpTier | null }>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * `null` means "this person has no standing in this scope at all" — the caller
   * turns that into a 401 indistinguishable from an unknown or revoked token.
   *
   * ⚠ A FAILED READ THROWS rather than answering, and that is the opposite direction
   * from `mcpEnabled()` on purpose. That one is a switch, so a database blip must
   * not read as "the product is off". This is an authority check, and a blip must
   * never read as "they are still an administrator".
   */
  async ceilingFor(userId: string, scopeId: string): Promise<McpTier | null> {
    // NUL rather than a space: a scope id is `personal:<userId>`, so a separator
    // that can appear inside either half is one that can be forced into a collision.
    const key = `${userId}\u0000${scopeId}`;
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < McpAuthorityService.TTL_MS) return hit.ceiling;

    const ceiling = await this.compute(userId, scopeId);
    this.cache.set(key, { at: now, ceiling });
    this.evictStale(now);
    return ceiling;
  }

  /**
   * Drop entries nobody can still be served from.
   *
   * The map is bounded by real people — an entry only appears once a token row has
   * already matched — so it was never going to grow without limit. But nothing ever
   * removed the entry for a deleted user or a revoked token either, and "small and
   * permanent" in a process that runs for months is still a leak. Sweeping only when
   * the map is worth sweeping keeps this off the hot path.
   */
  private evictStale(now: number): void {
    if (this.cache.size < McpAuthorityService.SWEEP_AT) return;
    for (const [key, entry] of this.cache) {
      if (now - entry.at >= McpAuthorityService.TTL_MS) this.cache.delete(key);
    }
  }

  private async compute(userId: string, scopeId: string): Promise<McpTier | null> {
    const user = await this.user(userId);
    if (!user) return null;

    // A personal scope IS its owner. A token whose scope names somebody else's
    // personal fleet is not a thing that can legitimately exist.
    if (scopeId.startsWith("personal:")) {
      return scopeId === `personal:${userId}` ? "admin" : null;
    }

    if (!(await this.isMember(userId, scopeId))) return null;

    // Rebuilt rather than reimplemented: one rule, in `session-scope.ts`.
    const session: ScopedSession = {
      user: { id: userId, role: user.role },
      session: { activeOrganizationId: scopeId },
    };
    return mcpCeilingFor(session);
  }

  private async user(userId: string): Promise<{ role: string | null } | null> {
    const rows = (await this.dataSource.query(
      'SELECT "role", "banned", "banExpires" FROM "user" WHERE "id" = $1 LIMIT 1',
      [userId],
    )) as { role: string | null; banned: boolean | null; banExpires: Date | string | null }[];
    const row = rows[0];
    if (!row) return null;
    // ⚠ A BAN CAN EXPIRE. Treating `banned` alone as final would keep somebody out
    // after their suspension ended, which reads as a broken token rather than a
    // policy — and the column exists precisely because bans are meant to lift.
    //
    // ⚠ AND THE DEADLINE IS NORMALISED RATHER THAN ASSUMED. `pg` maps timestamptz to
    // a Date today, but this is a raw query against a table another migrator owns:
    // a driver or a type-parser change that handed back a string would make
    // `.getTime()` throw, and a throw here fails the request rather than the ban.
    if (row.banned && !banHasLifted(row.banExpires)) return null;
    return { role: row.role };
  }

  private async isMember(userId: string, organizationId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      'SELECT 1 FROM "member" WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1',
      [userId, organizationId],
    )) as unknown[];
    return rows.length > 0;
  }
}
