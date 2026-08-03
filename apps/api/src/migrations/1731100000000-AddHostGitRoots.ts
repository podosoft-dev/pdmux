import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `host_git_roots` — the directories ONE host's agent scans for checkouts.
 *
 * WHY A PER-HOST TABLE AND NOT A SETTING: until now `gitRoots` was a single list
 * per fleet, and the values in it are absolute paths ON THE HOST. One list shared
 * by every machine is only correct when every machine has the same layout — the
 * moment it does not, every host that lacks the path reports `git.root_missing`
 * forever, which the repro doc already records as expected rather than a bug.
 *
 * ⚠ THE FLEET SETTING IS NOT REMOVED, AND THIS TABLE STARTS EMPTY. Rows here take
 * over for a host when it has any; with none it keeps using the fleet list. So the
 * day this ships, every host behaves exactly as it did — there is nothing to
 * migrate and nothing to break. The same rule the host `address` already follows:
 * the value somebody typed for this machine wins over the fleet-wide answer.
 *
 * ⚠ `enabled` mirrors `host_services`: turning a root off stops the agent scanning
 * it without throwing away the path somebody worked out. Deleting is still there
 * for a path that was simply wrong.
 *
 * Additive and safe on a running server: code that has never heard of the table
 * ignores it, which is why this migration can go first and cannot go second.
 */
export class AddHostGitRoots1731100000000 implements MigrationInterface {
  name = "AddHostGitRoots1731100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "host_git_roots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostId" uuid NOT NULL,
        "path" character varying(1024) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_host_git_roots_id" PRIMARY KEY ("id")
      )
    `);
    // The same path twice on one host would send the agent walking it twice and
    // show the operator a duplicate row that cannot be told apart from the first.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_host_git_roots_host_path" ON "host_git_roots" ("hostId", "path")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_host_git_roots_host_order" ON "host_git_roots" ("hostId", "sortOrder")`,
    );
    // Deleting a host takes its roots with it, exactly as it takes its services.
    await queryRunner.query(`
      ALTER TABLE "host_git_roots"
      ADD CONSTRAINT "FK_host_git_roots_host" FOREIGN KEY ("hostId")
      REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "host_git_roots"`);
  }
}
