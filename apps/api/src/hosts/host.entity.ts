import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { AgentConnectorAbility, Heartbeat, UpdateStatus } from "@pdmux/protocol";
import { HostService } from "./host-service.entity";

/**
 * A machine the dashboard operates. Rows are owned by a scope (organization or a
 * personal fallback — see fleet/session-scope.ts) and never queried without it.
 *
 * The host row carries the *latest* heartbeat inline. WHY: painting the sidebar
 * needs one row per host plus its current numbers; joining a time-series table for
 * "the newest sample per host" is the query that gets slow first, and the trend
 * graph reads host_metric_samples anyway.
 */
@Entity("hosts")
@Index(["organizationId", "label"], { unique: true })
@Index(["organizationId", "sortOrder"])
export class Host {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  /** Display name, unique inside the scope. */
  @Column({ type: "varchar", length: 64 })
  label!: string;

  /** Hostname or IP shown in the UI. Optional: an agent dials out, so the server
   *  never needs a reachable address to work — it is operator context only. */
  @Column({ type: "varchar", length: 255, nullable: true })
  address!: string | null;

  /**
   * Where the HOST says it can be reached, from its own `hello`.
   *
   * ⚠ Not the same question as `address`, and not answerable from here. `address` is
   * the operator's: typed by hand, the base for service links, and the one that wins.
   * This one is observed by the agent asking its own kernel which source address
   * reaches the server — because what a server sees is the far end of a socket, and
   * the agent dials out through whatever proxy or bridge sits between them.
   *
   * NULL until an agent new enough to report it connects.
   */
  @Column({ type: "varchar", length: 255, nullable: true })
  agentAddress!: string | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  description!: string | null;

  @Column({ type: "text", array: true, default: () => "'{}'" })
  tags!: string[];

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  /** A disabled host stays registered (tokens, history) but is hidden and its
   *  agent connection is rejected — the way to park a machine without losing it. */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ type: "varchar", length: 32, nullable: true })
  agentVersion!: string | null;

  /** `hello.protocolVersion`. Null until the host has connected once — which is
   *  exactly the "we cannot judge it" case the version state renders as unknown. */
  @Column({ type: "int", nullable: true })
  agentProtocolVersion!: number | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  os!: string | null;

  @Column({ type: "varchar", length: 32, nullable: true })
  arch!: string | null;

  /** Capabilities the agent announced in `hello` (metrics, terminal, git, …). */
  @Column({ type: "text", array: true, default: () => "'{}'" })
  capabilities!: string[];

  /** Growable connector abilities, kept outside the protocol's closed capability enum. */
  @Column({ type: "jsonb", default: () => "'{\"cloudflared\":false}'::jsonb" })
  connectorCapabilities!: AgentConnectorAbility;

  /**
   * When the server last heard from this host's agent. NULL means it has NEVER
   * connected — a distinct fact from "was here, now offline", and the only signal
   * that tells the two apart.
   *
   * ⚠ INDEXED, and the name AND the `where` are pinned so this matches the
   * migration that creates it (`1730900000000-AddHostLastSeenIndex`) exactly —
   * otherwise `synchronize` in development would drop the partial index and put a
   * full one back, and the two environments would stop being the same database.
   * The stale-host sweep scans on this column across every scope, and it had no
   * index at all: a sequential scan is invisible on a ten-host install and is the
   * query that gets slow first.
   */
  @Index("IDX_hosts_lastSeenAt", { where: '"lastSeenAt" IS NOT NULL' })
  @Column({ type: "timestamptz", nullable: true })
  lastSeenAt!: Date | null;

  /** Newest heartbeat payload, as received. Kept whole so a new protocol field is
   *  readable by the UI before the server has a column for it. */
  @Column({ type: "jsonb", nullable: true })
  lastHeartbeat!: Heartbeat | null;

  /**
   * Newest `updateStatus` frame, as received — progress and outcome share one
   * shape, so this is both "an update is running" and "how the last one ended".
   *
   * Stored whole for the same reason as `lastHeartbeat`: the agent's update
   * reporting will grow fields (a signature check, a byte counter) and the UI can
   * read them before this server has a column for any of them. It is deliberately
   * a snapshot, not a history — the audit log already records who asked for what,
   * and a per-host job table would be a second source of truth for one row of UI.
   */
  @Column({ type: "jsonb", nullable: true })
  lastUpdate!: UpdateStatus | null;

  @OneToMany(() => HostService, (service) => service.host)
  services?: HostService[];

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
