import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Host } from "../hosts/host.entity";
import { AgentToken } from "./agent-token.entity";

/**
 * A one-shot ticket that buys exactly one agent token for exactly one host.
 *
 * ONLY THE HASH IS STORED, like agent_tokens — the plaintext is shown once at
 * creation. Unlike a token this row also carries an expiry and a consumption
 * stamp, which is the whole point: the credential in the installer one-liner is
 * worthless minutes later and cannot be replayed by whoever finds it in shell
 * history.
 *
 * NO `organizationId` COLUMN: the scope is reached through `hostId -> hosts`, the
 * way agent_tokens does it. A second copy of the tenant key is how rows leak —
 * one of the two is eventually written from the wrong side and no query notices.
 *
 * NO ATTEMPTS COUNTER: a wrong code matches no row, so there is nothing to count
 * against. Guessing is answered by 100 bits of entropy plus the route's rate limit.
 */
@Entity("agent_enrollments")
@Index(["hostId"])
// At most one live code per host, enforced by the database rather than by a
// check-then-insert in the service (which two admin clicks race straight past).
@Index("IDX_agent_enrollments_live", ["hostId"], {
  unique: true,
  where: `"consumedAt" IS NULL AND "revokedAt" IS NULL`,
})
export class AgentEnrollment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  host?: Host;

  /** sha256 hex of the canonical code. Unique so redemption is one indexed read. */
  @Column({ type: "varchar", length: 64, unique: true })
  codeHash!: string;

  /** NOT NULL on purpose — the column agent_tokens deliberately lacks. A code
   *  with no expiry is a token with extra steps. */
  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  consumedAt!: Date | null;

  /** Who redeemed it, for the operator who wants to know whether the machine that
   *  came online is the machine they meant. Wide enough for IPv6. */
  @Column({ type: "varchar", length: 45, nullable: true })
  consumedIp!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  /** The token this code bought. SET NULL rather than CASCADE: deleting a token
   *  must not erase the evidence that an enrollment happened. */
  /**
   * How long the token this code buys should live, in days. NULL means never.
   *
   * ⚠ IT LIVES HERE RATHER THAN BEING ASKED FOR AT REDEMPTION because the party
   * redeeming is the machine being enrolled, and a machine asked how long its own
   * credential should last answers "forever". The operator chooses when the code is
   * minted; `redeem` reads the number off the row it is spending.
   */
  @Column({ type: "int", nullable: true })
  tokenExpiresInDays!: number | null;

  @Column({ type: "uuid", nullable: true })
  tokenId!: string | null;

  @ManyToOne(() => AgentToken, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "tokenId" })
  token?: AgentToken | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
