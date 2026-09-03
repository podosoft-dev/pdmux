import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type IntegrationProvider = "cloudflare";

export interface CloudflareConnectionConfig {
  accountId: string;
  zoneId: string;
  zoneName: string;
  baseDomain: string;
  accessPolicyId: string;
  accessPolicyName: string;
}

/** Fleet-scoped credentials and non-secret provider configuration. */
@Entity("integration_connections")
@Index(["organizationId", "provider"], { unique: true })
export class IntegrationConnection {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  @Column({ type: "varchar", length: 32 })
  provider!: IntegrationProvider;

  @Column({ type: "jsonb" })
  config!: CloudflareConnectionConfig;

  /** Envelope-encrypted API token. It is never returned from an API view. */
  @Column({ type: "text" })
  secret!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
