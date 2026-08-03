import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/** Admin-managed auth configuration, one row per section: one `social.<id>` row
 *  per configured OAuth provider (added/removed dynamically — "social.google",
 *  "social.github", "social.apple", …), plus "smtp" and "server". Non-secret
 *  fields live in `config` (jsonb); secrets (OAuth client secret, SMTP password)
 *  are stored encrypted in `secret` (AES-256-GCM envelope — see auth/secret.ts).
 *  The runtime reads this table through auth/config-store.ts (raw pool) to
 *  (re)build better-auth. */
@Entity({ name: "auth_config" })
export class AuthConfigRow {
  @PrimaryColumn({ type: "text" })
  key!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  @Column({ type: "jsonb", default: {} })
  config!: Record<string, unknown>;

  @Column({ type: "text", nullable: true })
  secret!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
