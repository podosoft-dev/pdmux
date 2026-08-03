import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitAppSettings1720400000000 implements MigrationInterface {
  name = "InitAppSettings1720400000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "app_setting" (
        "key" text NOT NULL,
        "value" text NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_setting_key" PRIMARY KEY ("key")
      )
    `);
    // Shipped defaults for the admin-managed auth feature flags (single source of
    // truth is this table; toggle them on the admin Settings page). Must match
    // FLAG_DEFAULTS in settings/settings.service.ts. phoneNumber ships off —
    // real SMS delivery needs a provider wired into sendOTP.
    await queryRunner.query(`
      INSERT INTO "app_setting" ("key", "value") VALUES
        ('twoFactor', 'true'),
        ('magicLink', 'true'),
        ('emailOtp', 'true'),
        ('username', 'true'),
        ('multiSession', 'true'),
        ('phoneNumber', 'false'),
        ('apiKey', 'true'),
        ('passkey', 'true'),
        ('organization', 'true'),
        ('oidcProvider', 'false')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "app_setting"`);
  }
}
