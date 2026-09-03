import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { IntegrationProvider } from "./integration-connection.entity";

/** One provider-owned connector per host. Cloudflare connectors own a dedicated tunnel. */
@Entity("host_connectors")
@Index(["hostId", "provider"], { unique: true })
@Index(["integrationId"])
export class HostConnector {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  integrationId!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @Column({ type: "varchar", length: 32 })
  provider!: IntegrationProvider;

  @Column({ type: "varchar", length: 128 })
  externalId!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  /** Envelope-encrypted runtime token consumed only when building agent config. */
  @Column({ type: "text" })
  secret!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
