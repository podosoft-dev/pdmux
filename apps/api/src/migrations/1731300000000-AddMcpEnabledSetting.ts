import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Seeds the row behind the MCP kill switch.
 *
 * A separate migration rather than an edit to `InitAppSettings` because that one has
 * already run on every live install — editing it would change nothing anywhere and
 * quietly leave the row missing.
 *
 * ⚠ IT SHIPS ON. Host-scoped MCP keys already exist and are in use; an upgrade that
 * turned them off would read as the product breaking rather than as a policy. The
 * per-scope switch that governs the NEW, fleet-wide credential ships off instead —
 * see `mcpUserTokens` in `fleet-settings.ts`, and the reasoning
 * `staleHostRetentionDays` already wrote down about capabilities arriving by upgrade.
 *
 * ⚠ `ON CONFLICT DO NOTHING` so an operator who set it before this migration ran
 * (or a re-run) keeps their choice. `mcp-enabled.ts` also treats a MISSING row as
 * the shipped default rather than as "off", so the switch is safe either side of it.
 */
export class AddMcpEnabledSetting1731300000000 implements MigrationInterface {
  name = "AddMcpEnabledSetting1731300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "app_setting" ("key", "value") VALUES ('mcpEnabled', 'true')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "app_setting" WHERE "key" = 'mcpEnabled'`);
  }
}
