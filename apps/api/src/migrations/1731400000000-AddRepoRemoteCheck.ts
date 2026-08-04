import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stores the last "what does the remote have right now" check for a checkout.
 *
 * ⚠ IT IS NOT A SECOND REF TABLE, and `repo_refs` is why. Those rows are LOCAL
 * pointers — including `refs/remotes/*`, which is a remote-TRACKING ref and
 * therefore exactly as old as the last fetch somebody ran by hand. These three
 * columns hold something different in kind: what the remote itself answered when
 * a person pressed the button. Mixing them into one table would make "as of the
 * last fetch" and "as of a moment ago" indistinguishable, which is the confusion
 * the whole feature exists to end.
 *
 * ⚠ NULLABLE, AND IT STAYS NULL UNTIL SOMEBODY ASKS. The check costs a network
 * round trip per repository, so it never rides the periodic pass — a repo whose
 * remote has never been checked has no answer, and that is a state the UI says
 * out loud rather than a zero it renders as "up to date".
 */
export class AddRepoRemoteCheck1731400000000 implements MigrationInterface {
  name = "AddRepoRemoteCheck1731400000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" ADD "remoteRefs" jsonb`);
    await queryRunner.query(`ALTER TABLE "repos" ADD "remoteCheckedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "repos" ADD "remoteError" character varying(512)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "remoteError"`);
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "remoteCheckedAt"`);
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "remoteRefs"`);
  }
}
