import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { AppException } from "../common/app-exception";
import { McpAuthorityService } from "./mcp-authority.service";
import { minTier, tierAtMost, type McpTier } from "./mcp-tier";
import { UserMcpKey } from "./user-mcp-key.entity";
import {
  MCP_TOKEN_EXPIRING_SOON_DAYS,
  expiryFrom,
  hashMcpToken,
  looksLikeMcpToken,
  mintMcpToken,
  tokenHashEquals,
  type McpTokenExpiryDays,
} from "./user-mcp-key.crypto";

/** What a list shows. Never the secret. */
export interface McpTokenView {
  id: string;
  label: string;
  keyPrefix: string;
  tier: McpTier;
  /**
   * What this token would actually get if it were presented right now, or `null`
   * when its owner has lost the scope entirely. Surfacing it is what turns a silent
   * downgrade into a row that explains itself.
   */
  effectiveTier: McpTier | null;
  expiresAt: string;
  expiringSoon: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Creation additionally returns the plaintext, exactly once. */
export interface MintedMcpToken extends McpTokenView {
  token: string;
}

/** What a presented fleet token resolves to. */
export interface McpUserIdentity {
  keyId: string;
  userId: string;
  organizationId: string;
  /** What the row stores — what the person was granted. */
  tier: McpTier;
  /** ⚠ What the tools gate on: the minimum of the above and current authority. */
  effectiveTier: McpTier;
}

function expiringSoon(expiresAt: Date): boolean {
  const remainingMs = expiresAt.getTime() - Date.now();
  return remainingMs > 0 && remainingMs <= MCP_TOKEN_EXPIRING_SOON_DAYS * 86_400_000;
}

function view(row: UserMcpKey, effectiveTier: McpTier | null): McpTokenView {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.keyPrefix,
    tier: row.tier,
    effectiveTier,
    expiresAt: row.expiresAt.toISOString(),
    expiringSoon: expiringSoon(row.expiresAt),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class UserMcpKeysService {
  constructor(
    @InjectRepository(UserMcpKey) private readonly tokens: Repository<UserMcpKey>,
    private readonly authority: McpAuthorityService,
  ) {}

  /** A person's own tokens in one scope. Never anybody else's. */
  async list(organizationId: string, userId: string): Promise<McpTokenView[]> {
    const rows = await this.tokens.find({
      where: { organizationId, userId },
      order: { createdAt: "DESC" },
    });
    const ceiling = await this.authority.ceilingFor(userId, organizationId);
    return rows.map((row) => view(row, ceiling === null ? null : minTier(row.tier, ceiling)));
  }

  /**
   * ⚠ THE CEILING IS CHECKED HERE AND AGAIN AT EVERY AUTHENTICATION. This one gives
   * a person a clear 403 at the moment they ask for too much; the other is what
   * keeps the answer true afterwards. Neither replaces the other.
   */
  async mint(
    organizationId: string,
    userId: string,
    input: { label: string; expiresInDays: McpTokenExpiryDays; tier: McpTier },
  ): Promise<MintedMcpToken> {
    const ceiling = await this.authority.ceilingFor(userId, organizationId);
    if (ceiling === null) {
      throw new AppException("MCP_FLEET_ADMIN_REQUIRED", "You have no access to this fleet.", 403);
    }
    if (!tierAtMost(input.tier, ceiling)) {
      throw new AppException(
        "MCP_TIER_ABOVE_CEILING",
        `Only a fleet administrator can create a ${input.tier} token. Yours can reach ${ceiling}.`,
        403,
      );
    }

    const minted = mintMcpToken();
    const row = await this.tokens.save(
      this.tokens.create({
        organizationId,
        userId,
        label: input.label.trim(),
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        tier: input.tier,
        expiresAt: expiryFrom(new Date(), input.expiresInDays),
        lastUsedAt: null,
        revokedAt: null,
      }),
    );
    // The only render of the plaintext. Nothing derived from it is stored, so a
    // later read cannot reproduce even the tail.
    return { ...view(row, minTier(row.tier, ceiling)), token: minted.token };
  }

  async revoke(organizationId: string, userId: string, id: string): Promise<McpTokenView> {
    const row = await this.tokens.findOne({ where: { id, organizationId, userId } });
    if (!row) throw new AppException("MCP_TOKEN_NOT_FOUND", "MCP token not found", 404);
    // Idempotent on the timestamp: revoking twice must not move the evidence of
    // when access actually ended.
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      await this.tokens.update({ id: row.id }, { revokedAt: row.revokedAt });
    }
    return view(row, null);
  }

  /**
   * Plaintext -> the fleet it speaks for, at the authority its owner has NOW.
   *
   * Returns null for anything that is not a live token, WITHOUT distinguishing
   * unknown from revoked from expired from "you are no longer in that organization".
   * The endpoint answers 401 for all of them: telling them apart tells an attacker
   * which guesses were once real, and tells a removed member exactly what changed.
   */
  async authenticate(plaintext: string): Promise<McpUserIdentity | null> {
    if (!looksLikeMcpToken(plaintext)) return null;
    const keyHash = hashMcpToken(plaintext);
    const row = await this.tokens.findOne({ where: { keyHash, revokedAt: IsNull() } });
    if (!row || !tokenHashEquals(row.keyHash, keyHash)) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    // ⚠ THE CHECK THAT MAKES THIS TOKEN SAFE TO OUTLIVE ITS MOMENT. Without it, a
    // token minted by an administrator who was later removed from the organization
    // keeps fleet-wide power for the rest of its life.
    const ceiling = await this.authority.ceilingFor(row.userId, row.organizationId);
    if (ceiling === null) return null;

    // One write per authentication, not per tool call: the endpoint is stateless and
    // a busy agent would otherwise write on every request.
    void this.tokens.update({ id: row.id }, { lastUsedAt: new Date() });
    return {
      keyId: row.id,
      userId: row.userId,
      organizationId: row.organizationId,
      tier: row.tier,
      effectiveTier: minTier(row.tier, ceiling),
    };
  }
}
