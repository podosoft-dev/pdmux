import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * When a checkout went missing from its host's report, so a dead repo can be dropped.
 *
 * Repos were only ever created and updated. A checkout that was deleted, moved, or
 * stopped being a checkout kept its row, its refs and its commits indefinitely — and
 * kept them FROZEN, which is the part that showed. `clearStaleWindowPositions` and
 * `upsertCommits` only run for a repo the agent still reports, so a repo that fell out
 * of the report holds whatever `seq` it last had; for rows collected before `seq`
 * existed that is NULL forever, the graph read falls back to `date DESC`, and two
 * commits sharing an author second come back in an order nothing guarantees. Measured
 * on a stale checkout of 54 commits and no merges: it drew as two lanes, with 48 of
 * those rows displaced onto the second one.
 *
 * Nullable, no backfill, no default. NULL means "being reported", which is the correct
 * state for every existing row: the next full snapshot marks the ones that are gone,
 * and only a later snapshot can sweep them.
 *
 * ⚠ Additive on purpose — invisible to the code running before it and a valid state for
 * the code running after it, so it can be applied while the server is up.
 */
export class AddRepoMissingSince1730400000000 implements MigrationInterface {
  name = "AddRepoMissingSince1730400000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" ADD COLUMN "missingSince" TIMESTAMP WITH TIME ZONE`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "missingSince"`);
  }
}
