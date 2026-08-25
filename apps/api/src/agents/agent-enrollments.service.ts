import { IsNull, MoreThan, Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import { HostsService, type IssuedEnrollment } from "../hosts/hosts.service";
import { AgentEnrollment } from "./agent-enrollment.entity";
import {
  canonicalizeEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
  mintEnrollmentCode,
} from "./agent-enrollment.crypto";
import { tokenHashEquals } from "./agent-token.crypto";
import { AgentTokensService } from "./agent-tokens.service";

/**
 * Long enough to walk to the other machine and paste, short enough that a code
 * left on screen (or in the scrollback of a shared terminal) is dead by the time
 * anyone else reads it.
 */
export const ENROLLMENT_TTL_MS = 15 * 60_000;

export type AgentEnrollmentStatus = "live" | "consumed" | "revoked" | "expired";

/** What an operator may see about a code. Never the code itself. */
export interface AgentEnrollmentView {
  id: string;
  hostId: string;
  status: AgentEnrollmentStatus;
  expiresAt: string;
  /** Floored at 0 so a UI countdown never renders a negative number. */
  expiresInSec: number;
  consumedAt: string | null;
  consumedIp: string | null;
  revokedAt: string | null;
  tokenId: string | null;
  createdAt: string;
}

/**
 * Creation additionally returns the plaintext, exactly once.
 *
 * `masked` is here and NOT on the view because nothing derived from the code is
 * stored: the row has a hash and nothing else, so a later read has no way to
 * reproduce even the tail of it. That is deliberate — a stored hint is a piece of
 * a live secret sitting in every listing and every screenshot of one.
 */
export interface MintedAgentEnrollment extends AgentEnrollmentView {
  code: string;
  masked: string;
}

/** What the installer gets back: everything it needs to write its config file. */
export interface EnrolledAgent {
  hostId: string;
  hostLabel: string;
  token: string;
  tokenId: string;
  tokenName: string;
}

/**
 * One 401 for every failure mode a script can trigger.
 *
 * WHY OPAQUE: malformed, unknown, expired, already consumed and revoked are all
 * the same answer, mirroring AgentTokensService.resolve()'s refusal to tell an
 * unknown token from a revoked one. Distinguishing them turns the endpoint into
 * an oracle ("this code exists, it is merely expired") for anyone spraying codes.
 * The operator sees which it actually was on `GET /hosts/:id/enrollments/current`.
 */
function invalidCode(): AppException {
  return new AppException("ENROLL_CODE_INVALID", "Enrollment code is not valid", 401);
}

function statusOf(row: AgentEnrollment, now: number): AgentEnrollmentStatus {
  if (row.consumedAt) return "consumed";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now) return "expired";
  return "live";
}

function toView(row: AgentEnrollment, now = Date.now()): AgentEnrollmentView {
  return {
    id: row.id,
    hostId: row.hostId,
    status: statusOf(row, now),
    expiresAt: row.expiresAt.toISOString(),
    expiresInSec: Math.max(0, Math.floor((row.expiresAt.getTime() - now) / 1000)),
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
    consumedIp: row.consumedIp,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    tokenId: row.tokenId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Names the token after the way it was created, so a revocation list reads as
 *  history: "installer 2026-07-26T09:14Z". Well inside the column's 64 chars. */
function installerTokenName(now: Date): string {
  return `installer ${now.toISOString().slice(0, 16)}Z`;
}

/** Postgres unique-violation. Only reachable through the partial index below. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export class AgentEnrollmentsService {
  constructor(
    private readonly enrollments: Repository<AgentEnrollment>,
    private readonly hosts: HostsService,
    private readonly tokens: AgentTokensService,
  ) {}

  /**
   * Lets `POST /hosts` hand a code over with the host it just created.
   *
   * Registered here rather than injected there because this service already
   * depends on `HostsService`: the arrow only points one way, exactly like the
   * gateway's `setConnectedProbe`. The host side treats a throw from this as "no
   * code", so nothing about creating a host rides on the mint succeeding.
   */
  connect(): void {
    this.hosts.setEnrollmentIssuer(async (organizationId, hostId, createdByUserId): Promise<IssuedEnrollment> => {
      const minted = await this.create(organizationId, hostId, createdByUserId);
      // Narrowed on purpose: the caller gets the secret, its id and its deadline,
      // not the whole row's audit fields.
      return {
        id: minted.id,
        code: minted.code,
        expiresAt: minted.expiresAt,
        expiresInSec: minted.expiresInSec,
      };
    });
  }

  /**
   * Mint a code for a host, retiring whatever code that host had.
   *
   * WHY REPLACE RATHER THAN REFUSE: "regenerate" is the operator's answer to every
   * mishap here (mistyped, expired, redeemed by the wrong machine), and it has to
   * be one click. Retiring the old row in the same call means two codes for one
   * host are never valid at once, so a stale screenshot is dead the moment a new
   * code is shown.
   */
  async create(
    organizationId: string,
    hostId: string,
    createdByUserId: string | null,
    tokenExpiresInDays: number | null = null,
  ): Promise<MintedAgentEnrollment> {
    const host = await this.hosts.get(organizationId, hostId);
    await this.enrollments.update(
      { hostId: host.id, consumedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    const { code, codeHash } = mintEnrollmentCode();
    const now = Date.now();
    const draft = this.enrollments.create({
      hostId: host.id,
      codeHash,
      expiresAt: new Date(now + ENROLLMENT_TTL_MS),
      consumedAt: null,
      consumedIp: null,
      revokedAt: null,
      // The operator's choice, parked until an installer spends the code.
      tokenExpiresInDays,
      tokenId: null,
      createdByUserId,
    });

    try {
      const row = await this.enrollments.save(draft);
      return { ...toView(row, now), code, masked: maskEnrollmentCode(code) };
    } catch (error) {
      // Two clicks landing together: the partial unique index rejects the loser
      // rather than leaving the host with two live codes. Say so plainly instead
      // of letting a driver error surface as a 500.
      if (isUniqueViolation(error)) {
        throw new AppException("ENROLL_CODE_CONFLICT", "Another code was just created; try again", 409);
      }
      throw error;
    }
  }

  /**
   * The host's current code, whatever state it is in — including `expired`, which
   * is exactly the question an operator has when an install failed.
   * At most one such row exists (partial unique index).
   */
  async current(organizationId: string, hostId: string): Promise<AgentEnrollmentView | null> {
    const host = await this.hosts.get(organizationId, hostId);
    const row = await this.enrollments.findOne({
      where: { hostId: host.id, consumedAt: IsNull(), revokedAt: IsNull() },
      order: { createdAt: "DESC" },
    });
    return row ? toView(row) : null;
  }

  async revoke(organizationId: string, hostId: string, id: string): Promise<AgentEnrollmentView> {
    const host = await this.hosts.get(organizationId, hostId);
    const row = await this.enrollments.findOne({ where: { id, hostId: host.id } });
    if (!row) throw new AppException("ENROLLMENT_NOT_FOUND", "Enrollment code not found", 404);
    // Revoking twice must not move the timestamp — the first revocation is the fact.
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      await this.enrollments.update({ id: row.id }, { revokedAt: row.revokedAt });
    }
    return toView(row);
  }

  /**
   * Public path: code -> a freshly minted token for the code's host.
   *
   * Reads first, then ONE atomic conditional write, then the mint. There is no
   * transaction: the claim is a single UPDATE whose WHERE clause carries every
   * precondition, so two installers redeeming the same code at the same instant
   * cannot both win — one gets `affected: 1`, the other gets 0 and the same 401
   * as a stranger. No lock, no retry, nothing to get wrong under load.
   *
   * DELIBERATE NON-COMPENSATION: if minting throws after the claim, the code stays
   * consumed. Single-use is unconditional — an "un-consume on failure" branch is
   * exactly the replayable code this whole mechanism exists to avoid, and the
   * recovery is one "regenerate" click. Do not "fix" this.
   */
  async redeem(rawCode: string, ip: string | null): Promise<EnrolledAgent> {
    const canonical = canonicalizeEnrollmentCode(rawCode);
    if (!canonical) throw invalidCode(); // malformed: not one database round trip

    const codeHash = hashEnrollmentCode(canonical);
    const row = await this.enrollments.findOne({ where: { codeHash } });
    // Belt and braces: the lookup was by hash, so this can only fail if the row
    // came back some other way, but the compare is constant-time regardless.
    if (!row || !tokenHashEquals(row.codeHash, codeHash)) throw invalidCode();

    const host = await this.hosts.getById(row.hostId);
    if (!host) throw invalidCode(); // orphan row; the FK cascade should prevent it
    if (!host.enabled) {
      // NOT consumed. The holder of this code is legitimate and the operator fixes
      // this with one toggle — burning the code here would force a regenerate (and
      // a second trip to the machine) for a server-side decision.
      throw new AppException("HOST_DISABLED", "This host is disabled", 409);
    }

    const now = new Date();
    const claimed = await this.enrollments.update(
      { id: row.id, consumedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(now) },
      { consumedAt: now, consumedIp: ip },
    );
    if (claimed.affected !== 1) throw invalidCode(); // expired, revoked, or already spent

    // NEVER touch the host's existing tokens. A 15-minute code must not be able to
    // kick a live agent off its socket, and an in-place upgrade re-enrols legitimately.
    //
    // The lifetime comes off the ROW, not off anything the caller sent: the caller
    // here is the machine being enrolled, and a machine is not entitled to choose
    // how long its own credential lasts.
    const minted = await this.tokens.mint(
      host.organizationId,
      host.id,
      installerTokenName(now),
      row.tokenExpiresInDays,
    );
    await this.enrollments.update({ id: row.id }, { tokenId: minted.id });

    return {
      hostId: host.id,
      hostLabel: host.label,
      token: minted.token,
      tokenId: minted.id,
      tokenName: minted.name,
    };
  }
}
