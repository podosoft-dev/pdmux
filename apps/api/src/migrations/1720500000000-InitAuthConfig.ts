import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitAuthConfig1720500000000 implements MigrationInterface {
  name = "InitAuthConfig1720500000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    // Admin-managed auth configuration (OAuth providers, SMTP, server-enforced
    // toggles). Secrets (OAuth client secret, SMTP password) are stored encrypted
    // in "secret" (AES-256-GCM envelope; key derived from BETTER_AUTH_SECRET —
    // never in this DB). Non-secret fields live in "config" (jsonb). No rows are
    // seeded: an empty table means "use environment variables" (legacy behavior).
    await queryRunner.query(`
      CREATE TABLE "auth_config" (
        "key" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "config" jsonb NOT NULL DEFAULT '{}',
        "secret" text,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auth_config_key" PRIMARY KEY ("key")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "auth_config"`);
  }
}
