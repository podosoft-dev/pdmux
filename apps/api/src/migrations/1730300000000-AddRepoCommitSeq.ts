import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The window position the agent reported — the one thing that can reproduce the
 * order a graph has to be drawn in.
 *
 * The rows were read back ordered by `date`, which is the AUTHOR date (`%at`),
 * while the agent collects the window with `git log --date-order`, which is the
 * COMMITTER date. The two disagree for every commit that was rebased, amended,
 * cherry-picked or re-committed with its author date preserved — so a parent could
 * come back ahead of its child, and the lane algorithm (correctly, by its contract)
 * read that parent as a branch tip. Measured on `local-dev`: a 60-commit, 0-merge,
 * perfectly linear history drew as 3 lanes.
 *
 * Nullable, no backfill and no default. NULL means "no window has placed this row
 * yet" — a row collected before this column existed, or one a truncated window has
 * scrolled past. The read orders `seq ASC NULLS LAST, date DESC`, so those rows
 * keep exactly today's date ordering and fall behind the window instead of
 * interleaving with it; the first snapshot after this migration fills them in.
 *
 * ⚠ Additive on purpose: the column is invisible to the code running before it
 * (nothing selects it) and to the code running after it (NULL is a valid state),
 * so it can be applied while the server is up.
 */
export class AddRepoCommitSeq1730300000000 implements MigrationInterface {
  name = "AddRepoCommitSeq1730300000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repo_commits" ADD COLUMN "seq" integer`);
    // The graph read is (repoId, seq) — the existing (repoId, date) index cannot
    // serve it, and this is the query behind every open of the commit dock.
    await queryRunner.query(`CREATE INDEX "IDX_repo_commits_repo_seq" ON "repo_commits" ("repoId", "seq")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_repo_commits_repo_seq"`);
    await queryRunner.query(`ALTER TABLE "repo_commits" DROP COLUMN "seq"`);
  }
}
