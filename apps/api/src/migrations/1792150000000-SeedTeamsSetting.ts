import type { MigrationInterface, QueryRunner } from "typeorm";

/** Seeds the default of the organization teams setting (off), for new and
 *  existing databases. Better Auth's own migration creates the `team` and
 *  `teamMember` tables. Must match FLAG_DEFAULTS.teams in settings/flag-defaults.ts. */
export class SeedTeamsSetting1792150000000 implements MigrationInterface {
  name = "SeedTeamsSetting1792150000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "app_setting" ("key", "value") VALUES ('teams', 'false')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "app_setting" WHERE "key" = 'teams'`);
  }
}
