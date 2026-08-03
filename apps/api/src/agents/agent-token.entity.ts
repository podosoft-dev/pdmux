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

/**
 * The credential an agent presents on every connection.
 *
 * ONLY THE HASH IS STORED. The plaintext is returned once, at creation, and is
 * unrecoverable afterwards — so a database dump (or a screenshot of this table)
 * cannot be replayed against the fleet. Rotation mints a new secret and revokes
 * the old row rather than editing one in place, which keeps `lastUsedAt` evidence
 * of the compromised secret intact.
 */
@Entity("agent_tokens")
@Index(["hostId"])
export class AgentToken {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  host?: Host;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  /** sha256 hex of the plaintext token. Unique so a lookup is a single indexed read. */
  @Column({ type: "varchar", length: 64, unique: true })
  tokenHash!: string;

  /**
   * When the token stops working on its own. NULL — the default — means never.
   *
   * ⚠ NULLABLE WHERE `HostMcpKey.expiresAt` IS NOT: this credential belongs to a
   * machine that goes dark when it lapses and cannot renew itself, so an expiry is
   * a CHOICE the operator makes at issue time rather than a rule. See
   * `AGENT_TOKEN_EXPIRY_DAYS` for the reasoning and the values on offer.
   */
  @Column({ type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
