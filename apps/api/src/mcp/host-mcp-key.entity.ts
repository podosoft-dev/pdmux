import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { Host } from "../hosts/host.entity";
import type { McpKeyScope } from "./host-mcp-key.crypto";

/**
 * The credential a coding CLI presents to the MCP endpoint, on behalf of one host.
 *
 * ONLY THE HASH IS STORED, exactly as for `AgentToken`: the plaintext is returned
 * once at creation and is unrecoverable afterwards, so a database dump cannot be
 * replayed. Revocation is a timestamp rather than a delete — `lastUsedAt` is the
 * evidence of what a compromised key reached, and deleting the row destroys it.
 *
 * ⚠ IT IS BOUND TO A HOST, AND THAT IS THE WHOLE SECURITY MODEL. pdmux has no
 * project concept and registration is per person, so the host is the only boundary
 * there is: everything this key can read or run is reached through `hostId`, and a
 * request naming another host is answered 404 rather than 403 (403 confirms the id
 * exists — REQ-PDHOST-002).
 *
 * WHY IT HAS AN EXPIRY WHEN `AgentToken` DOES NOT: an agent token belongs to a
 * machine that would stop working if its credential lapsed, and rotating it is an
 * operator action with a rollout. This one belongs to a person's tooling, is minted
 * in two clicks, and is the kind of secret that ends up in a shell history — so it
 * dies on its own.
 */
@Entity("host_mcp_keys")
@Index(["hostId"])
export class HostMcpKey {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  host?: Host;

  /** What a person calls it in the list — "my laptop's codex". */
  @Column({ type: "varchar", length: 64 })
  label!: string;

  /** sha256 hex of the plaintext. Unique so a lookup is a single indexed read. */
  @Column({ type: "varchar", length: 64, unique: true })
  keyHash!: string;

  /**
   * The leading characters, in the clear, so the list can name a row without the
   * secret. Never enough to reconstruct anything.
   */
  @Column({ type: "varchar", length: 24 })
  keyPrefix!: string;

  /**
   * `read` alone is what makes `run_command` refuse.
   *
   * A text array rather than a bitmask or a boolean: the set is expected to grow,
   * and a boolean named `canWrite` would have to be migrated the first time it does.
   */
  @Column({ type: "text", array: true, default: () => "ARRAY['read','write']::text[]" })
  scopes!: McpKeyScope[];

  /** NOT NULL on purpose — the column `agent_tokens` deliberately lacks. */
  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  /** Who minted it, for the audit trail. Null once that user is deleted. */
  @Column({ type: "varchar", length: 128, nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
