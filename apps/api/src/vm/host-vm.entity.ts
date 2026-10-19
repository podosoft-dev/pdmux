import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import type { VmAction, VmState } from "./vm-provider";

/** `created`: pdmux made it and may delete it. `linked`: it existed already; pdmux only powers it. */
export type HostVmOrigin = "created" | "linked";
export type HostVmOperation = VmAction | "create" | "delete" | "enroll";

/**
 * The machine behind a host, and the one power change in flight on it.
 *
 * ⚠ THIS ROW IS THE TRUTH THE SCREENS DRAW, NOT THE PROVIDER. Every pane, tab and person looking
 * at this host reads the same `operation` and `observedState` from here, which is what keeps
 * them agreeing; the provider is observed into it (reconcile) and acted on from it. `version`
 * makes claiming an operation a conditional write, so two clicks in two panes start one task.
 */
@Entity("host_vms")
@Index("IDX_host_vms_host", ["hostId"], { unique: true })
@Index("IDX_host_vms_provider_external", ["providerId", "externalId"], { unique: true })
@Index("IDX_host_vms_scope", ["organizationId"])
export class HostVm {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @Column({ type: "uuid" })
  providerId!: string;

  /** Where the machine lives at its provider: a Proxmox node. */
  @Column({ type: "varchar", length: 64 })
  location!: string;

  /** The provider's id for it: a Proxmox VMID. */
  @Column({ type: "varchar", length: 128 })
  externalId!: string;

  @Column({ type: "varchar", length: 128 })
  name!: string;

  @Column({ type: "varchar", length: 16 })
  origin!: HostVmOrigin;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  spec!: { cores?: number; memoryMb?: number; template?: string };

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  tags!: string[];

  @Column({ type: "varchar", length: 16, default: "unknown" })
  observedState!: VmState;

  @Column({ type: "timestamptz", nullable: true })
  observedAt!: Date | null;

  @Column({ type: "varchar", length: 16, nullable: true })
  operation!: HostVmOperation | null;

  @Column({ type: "varchar", length: 32, nullable: true })
  operationStep!: string | null;

  /** The provider's task id (a Proxmox UPID) for the step in flight. */
  @Column({ type: "varchar", length: 255, nullable: true })
  operationTask!: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  operationRequestedById!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  operationRequestedByName!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  operationStartedAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  operationUpdatedAt!: Date | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  errorAt!: Date | null;

  /** The creating request's key, so a retried click creates one machine. */
  @Column({ type: "varchar", length: 64, nullable: true })
  idempotencyKey!: string | null;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
