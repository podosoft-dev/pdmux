import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddFileTransfers1731700000000 implements MigrationInterface {
  name = "AddFileTransfers1731700000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "file_transfers" (
      "id" uuid PRIMARY KEY, "userId" varchar(128) NOT NULL, "organizationId" varchar(128) NOT NULL,
      "hostId" uuid NOT NULL, "direction" varchar(16) NOT NULL, "basePath" text NOT NULL,
      "selection" text NOT NULL, "state" varchar(16) NOT NULL,
      "bytes" double precision NOT NULL DEFAULT 0, "totalBytes" double precision NOT NULL DEFAULT 0,
      "completedEntries" integer NOT NULL DEFAULT 0, "totalEntries" integer NOT NULL DEFAULT 0,
      "currentPath" text NOT NULL DEFAULT '', "errorCode" text NOT NULL DEFAULT '', "exclusions" text NOT NULL,
      "archiveBytes" double precision NOT NULL DEFAULT 0, "etag" text NOT NULL DEFAULT '',
      "updated" double precision NOT NULL, "created" double precision NOT NULL
    )`);
    await queryRunner.query('CREATE INDEX "IDX_file_transfers_owner" ON "file_transfers" ("userId", "organizationId", "hostId")');
    await queryRunner.query(`CREATE TABLE "file_transfer_entries" (
      "id" uuid PRIMARY KEY, "transferId" uuid NOT NULL, "path" text NOT NULL, "kind" varchar(16) NOT NULL,
      "size" double precision NOT NULL DEFAULT 0, "offset" double precision NOT NULL DEFAULT 0,
      "fingerprint" text NOT NULL DEFAULT '', "modified" text NOT NULL DEFAULT '',
      "state" varchar(16) NOT NULL DEFAULT 'pending', "replace" boolean NOT NULL DEFAULT false
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX "IDX_file_transfer_entries_path" ON "file_transfer_entries" ("transferId", "path")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "file_transfer_entries"');
    await queryRunner.query('DROP TABLE "file_transfers"');
  }
}
