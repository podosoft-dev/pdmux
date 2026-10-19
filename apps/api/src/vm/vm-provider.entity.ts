import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import type { VmProviderConfig, VmProviderKind } from "./vm-provider";

/**
 * A fleet's connection to a VM platform.
 *
 * Several per scope, unlike `integration_connections` (one per provider per scope): one
 * organization may run a cluster and standalone hosts, each its own API endpoint.
 */
@Entity("vm_providers")
@Index("IDX_vm_providers_scope_name", ["organizationId", "name"], { unique: true })
export class VmProvider {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  @Column({ type: "varchar", length: 32 })
  kind!: VmProviderKind;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "jsonb" })
  config!: VmProviderConfig;

  /** Envelope-encrypted credential. It is never returned from an API view. */
  @Column({ type: "text" })
  secret!: string;

  @Column({ type: "timestamptz", nullable: true })
  lastTestedAt!: Date | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  lastErrorCode!: string | null;

  /** One API replica reconciles a provider at a time; this is its lease. */
  @Column({ type: "timestamptz", nullable: true })
  reconcileLeaseUntil!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
