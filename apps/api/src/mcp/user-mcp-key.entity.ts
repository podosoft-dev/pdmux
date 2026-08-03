import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { McpTier } from "./mcp-tier";

/**
 * The credential a coding CLI presents to reach a whole fleet.
 *
 * Same storage discipline as `HostMcpKey`: only the hash, plaintext returned once,
 * revocation as a timestamp rather than a delete (`lastUsedAt` is the evidence of
 * what a compromised token reached, and deleting the row destroys it).
 *
 * ⚠ A SEPARATE TABLE, NOT A NULLABLE COLUMN ON `host_mcp_keys`. That table is built
 * around one sentence — "IT IS BOUND TO A HOST, AND THAT IS THE WHOLE SECURITY
 * MODEL" — held up by `hostId NOT NULL` and a cascading foreign key. Making it
 * nullable would put a discriminator in the authentication hot path, give the row
 * two mutually exclusive owner columns, and force the specs that pin that shape to
 * be rewritten around a shape they exist to hold still. Two tables keep the older
 * invariant literally true.
 *
 * ⚠ THE SCOPE IS A STRING, NOT A FOREIGN KEY, because that is what `resolveScopeId`
 * answers: an organization id, or the synthetic `personal:<userId>` that a
 * single-person install runs under. There is no table the second form points at,
 * which is exactly why `hosts.organizationId` is a plain varchar too.
 */
@Entity("user_mcp_keys")
@Index(["userId"])
@Index(["organizationId"])
export class UserMcpKey {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** The scope this token acts in, as `resolveScopeId(session)` answers it. */
  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  /**
   * The person the token speaks for.
   *
   * ⚠ NO FOREIGN KEY, for the reason `host_mcp_keys.createdByUserId` has none: the
   * `user` table belongs to better-auth and is created by its migrator, and a
   * cross-migrator constraint couples two release processes that do not know about
   * each other.
   *
   * ⚠ AND IT IS NOT MERELY AUDIT METADATA HERE, which is the difference from that
   * column. Every authentication re-reads this person's current authority and takes
   * the minimum with the stored tier, so a demoted or removed user's token weakens
   * on its next call rather than at some future cleanup.
   */
  @Column({ type: "varchar", length: 128 })
  userId!: string;

  /** What a person calls it in the list — "my laptop", "ci runner". */
  @Column({ type: "varchar", length: 64 })
  label!: string;

  /** sha256 hex of the plaintext. Unique so a lookup is a single indexed read. */
  @Column({ type: "varchar", length: 64, unique: true })
  keyHash!: string;

  /** The leading characters, in the clear, so a list can name a row. */
  @Column({ type: "varchar", length: 24 })
  keyPrefix!: string;

  /**
   * ⚠ ONE VALUE, NOT AN ARRAY. `HostMcpKey.scopes` is a set because a host key
   * really does carry independent capabilities; a fleet tier is a ladder, and
   * storing a ladder as a set is how "admin without write" becomes representable.
   */
  @Column({ type: "varchar", length: 16 })
  tier!: McpTier;

  /**
   * ⚠ NOT NULL, deliberately, and see `user-mcp-key.crypto.ts` for why there is no
   * "never" option: this credential is stronger than the host key that already
   * refuses one, and a nullable expiry is a fail-open branch in the hot path.
   */
  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  /** Written once per authentication, not per tool call. Evidence, not telemetry. */
  @Column({ type: "timestamptz", nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
