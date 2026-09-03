import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { IntegrationProvider } from "./integration-connection.entity";

export type ExposureMode = "access" | "public";
export type ExposureOriginScheme = "http" | "https";
export type ExposureStatus = "pending" | "protected" | "public" | "error";

/** Desired and provider-observed state for one externally reachable host service. */
@Entity("service_exposures")
@Index(["serviceId", "provider"], { unique: true })
@Index(["organizationId", "provider"])
@Index(["integrationId"])
@Index(["connectorId"])
export class ServiceExposure {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  integrationId!: string;

  @Column({ type: "uuid" })
  connectorId!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @Column({ type: "uuid" })
  serviceId!: string;

  @Column({ type: "varchar", length: 32 })
  provider!: IntegrationProvider;

  @Column({ type: "varchar", length: 253 })
  hostname!: string;

  @Column({ type: "varchar", length: 16 })
  mode!: ExposureMode;

  @Column({ type: "varchar", length: 8 })
  originScheme!: ExposureOriginScheme;

  @Column({ type: "boolean", default: false })
  noTlsVerify!: boolean;

  @Column({ type: "varchar", length: 16 })
  status!: ExposureStatus;

  @Column({ type: "varchar", length: 128, nullable: true })
  externalDnsRecordId!: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  externalAccessAppId!: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  errorCode!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
