import { Repository } from "typeorm";
import type { AgentRefusalReason } from "@pdmux/protocol";
import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import { AgentDisconnectService } from "./agent-disconnect.service";
import { AgentToken } from "./agent-token.entity";
import { expiryFrom, hashAgentToken, looksLikeAgentToken, mintAgentToken } from "./agent-token.crypto";

/** What a token row looks like to the UI — no secret material. */
export interface AgentTokenView {
  id: string;
  hostId: string;
  name: string;
  /** ISO, or null for "never" — see `AgentToken.expiresAt`. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Creation/rotation additionally returns the plaintext, exactly once. */
export interface MintedAgentToken extends AgentTokenView {
  token: string;
}

/** A presented secret that is a live token, and the host it speaks for. */
export interface ResolvedAgentToken {
  token: AgentToken;
  hostId: string;
}

/**
 * A presented secret that is NOT a live token, and which of the three it was.
 *
 * ⚠ THIS NEVER REACHES A RESPONSE. `resolve()` collapses all three to `null` and
 * the gateway answers one 401 for every one of them, exactly as it did before this
 * type existed. The distinction has one consumer — the refusal aggregate an
 * administrator reads — because "the token you installed was revoked three weeks
 * ago" and "that secret has never existed here" are different operator problems
 * and look identical from the outside. Telling them apart in a RESPONSE would be an
 * oracle: it says which guesses were once real, and it says when a real credential
 * lapsed.
 */
export interface RefusedAgentToken {
  refusal: Extract<AgentRefusalReason, "unknown" | "revoked" | "expired">;
  /**
   * Whose machine, when a row was actually found. Null for `unknown`, which is the
   * case where nothing was.
   *
   * Naming it is the difference between "somebody is being refused" and "build-01's
   * agent is still dialling with the token you revoked on Tuesday" — and it stays
   * inside the process either way.
   */
  hostId: string | null;
}

function isRefusal(outcome: ResolvedAgentToken | RefusedAgentToken): outcome is RefusedAgentToken {
  return "refusal" in outcome;
}

function toView(row: AgentToken): AgentTokenView {
  return {
    id: row.id,
    hostId: row.hostId,
    name: row.name,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AgentTokensService {
  constructor(
    private readonly tokens: Repository<AgentToken>,
    private readonly hosts: HostsService,
    private readonly disconnect: AgentDisconnectService,
  ) {}

  async list(organizationId: string, hostId: string): Promise<AgentTokenView[]> {
    const host = await this.hosts.get(organizationId, hostId);
    const rows = await this.tokens.find({ where: { hostId: host.id }, order: { createdAt: "DESC" } });
    return rows.map(toView);
  }

  /**
   * `expiresInDays` is opt-in and defaults to never — see `AGENT_TOKEN_EXPIRY_DAYS`.
   * The allow-list is enforced at the DTO; anything reaching here is already one of
   * the offered values (or the enrollment row's copy of one).
   */
  async mint(
    organizationId: string,
    hostId: string,
    name: string,
    expiresInDays: number | null = null,
  ): Promise<MintedAgentToken> {
    const host = await this.hosts.get(organizationId, hostId);
    return this.issue(host.id, name, expiresInDays === null ? null : expiryFrom(new Date(), expiresInDays));
  }

  /** Scope has already been checked by the caller; this is the row write alone. */
  private async issue(hostId: string, name: string, expiresAt: Date | null): Promise<MintedAgentToken> {
    const { token, tokenHash } = mintAgentToken();
    const row = await this.tokens.save(
      this.tokens.create({ hostId, name, tokenHash, expiresAt, lastUsedAt: null, revokedAt: null }),
    );
    return { ...toView(row), token };
  }

  /**
   * Rotation = mint a new row, then revoke the old one. The two secrets overlap
   * only for the moment between the calls, and the old row survives with its
   * `lastUsedAt`, which is the evidence you need if you rotated because of a leak.
   *
   * ⚠ ROTATION IS NOT EXEMPT FROM THE DISCONNECT, on purpose. It revokes, so it
   * hangs up on an agent still holding the old secret; that agent reconnects and is
   * refused until someone installs the new one.
   *
   * That is not new downtime — rotation already caused it, invisibly. The old token
   * stopped working the instant this method returned, so the running agent was
   * doomed from that moment and merely didn't know: it kept reporting until some
   * unrelated reconnect (hours or days later) turned into a 401 nobody was watching
   * for. Closing now moves that outage to the second the operator pressed the
   * button, with the new plaintext still on their screen.
   *
   * And rotation is most often the response to a leak, where leaving the socket the
   * compromised credential opened alive is precisely the hole this closes.
   *
   * The no-downtime procedure is therefore the one `docs/OPERATIONS.md` §2-4 already
   * documents, and it does not go through here: mint a NEW token → install it on the
   * agent → revoke the old one.
   *
   * ⚠ THE DEADLINE IS CARRIED, NOT RESTARTED. Rotation replaces a secret that may
   * have leaked, and a leak is not a reason to extend how long the machine stays
   * authorised — a fresh window here would mean anybody who rotates a 7-day token
   * silently turns it into another 7 days, forever, without deciding to. Extending
   * is a separate decision and it is made by minting.
   */
  async rotate(organizationId: string, hostId: string, id: string): Promise<MintedAgentToken> {
    const existing = await this.getScoped(organizationId, hostId, id);
    const minted = await this.issue(existing.hostId, existing.name, existing.expiresAt);
    await this.tokens.update({ id: existing.id }, { revokedAt: new Date() });
    this.disconnect.applyTokenRevoked(existing.id);
    return minted;
  }

  async revoke(organizationId: string, hostId: string, id: string): Promise<AgentTokenView> {
    const existing = await this.getScoped(organizationId, hostId, id);
    // Revoking twice must not move the timestamp — the first revocation is the fact.
    if (!existing.revokedAt) {
      existing.revokedAt = new Date();
      await this.tokens.update({ id: existing.id }, { revokedAt: existing.revokedAt });
    }
    // Outside the `if`: a revoked token whose socket somehow survived (a close that
    // failed, a process that took the connection over) must still be hung up on.
    // The call is a no-op when nothing is connected with this credential, which is
    // the normal case — and it never throws, so the revocation cannot fail here.
    this.disconnect.applyTokenRevoked(existing.id);
    return toView(existing);
  }

  /**
   * Gateway path: plaintext -> host id. Returns null for anything that is not a
   * live token, without distinguishing "unknown" from "revoked" from "expired" to
   * the caller.
   *
   * THE SINGLE GATE. Everything that authenticates an agent comes through here, so
   * a rule added here needs adding nowhere else — which is why the expiry check is
   * three lines below and not in the gateway.
   */
  async resolve(plaintext: string): Promise<ResolvedAgentToken | null> {
    const outcome = await this.resolveOrReason(plaintext);
    return isRefusal(outcome) ? null : outcome;
  }

  /**
   * The same lookup, plus WHY it failed. **Used by the gateway and nothing else.**
   *
   * ⚠ THE REASON IS FOR THE AGGREGATE, NEVER FOR THE RESPONSE. `resolve()` above is
   * the gate every caller should use; this one exists so the refusal an
   * administrator reads can say "revoked" instead of leaving an orphaned agent
   * indistinguishable from somebody spraying secrets. See `RefusedAgentToken`.
   *
   * ⚠ `revokedAt IS NULL` DELIBERATELY LEFT THE WHERE CLAUSE. It used to be part of
   * the query, which is what made a revoked token unreportable: no row came back,
   * so there was nothing to say it had ever existed. The branch below refuses the
   * same rows the predicate did, and it is the only path out of this method that
   * can return a token — there is no arrangement of these branches that hands back
   * a revoked or expired row.
   *
   * The expiry is compared in JS rather than in the query for the same reason the
   * MCP keys do it (`host-mcp-keys.service.ts`): a time predicate in the WHERE
   * clause makes the plan depend on the clock, and here it would additionally throw
   * away the one fact worth recording.
   */
  async resolveOrReason(plaintext: string): Promise<ResolvedAgentToken | RefusedAgentToken> {
    // Shape check first: a garbage header must not become a query.
    if (!looksLikeAgentToken(plaintext)) return { refusal: "unknown", hostId: null };
    const row = await this.tokens.findOne({ where: { tokenHash: hashAgentToken(plaintext) } });
    if (!row) return { refusal: "unknown", hostId: null };
    if (row.revokedAt) return { refusal: "revoked", hostId: row.hostId };
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return { refusal: "expired", hostId: row.hostId };
    }
    return { token: row, hostId: row.hostId };
  }

  /** Recorded on connect, not on every frame: one write per session, not per beat. */
  async markUsed(id: string): Promise<void> {
    await this.tokens.update({ id }, { lastUsedAt: new Date() });
  }

  private async getScoped(organizationId: string, hostId: string, id: string): Promise<AgentToken> {
    const host = await this.hosts.get(organizationId, hostId);
    const row = await this.tokens.findOne({ where: { id, hostId: host.id } });
    if (!row) throw new AppException("AGENT_TOKEN_NOT_FOUND", "Agent token not found", 404);
    return row;
  }
}
