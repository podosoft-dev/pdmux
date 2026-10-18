import type { MigrationInterface, QueryRunner } from "typeorm";
export class AddDesktopRecords1792300000000 implements MigrationInterface {
  name = "AddDesktopRecords1792300000000";
  async up(query: QueryRunner): Promise<void> {
    await query.query(`CREATE TABLE "desktop_records" (
      "id" varchar(64) PRIMARY KEY, "scopeId" varchar(256) NOT NULL, "userId" varchar(128) NOT NULL,
      "key" varchar(256) NOT NULL, "kind" varchar(32) NOT NULL, "origin" varchar(128) NOT NULL,
      "connectionKey" varchar(1024) NOT NULL DEFAULT '', "hostId" uuid,
      "value" jsonb, "cachedView" jsonb, "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await query.query(`CREATE TABLE "desktop_connections" ("userId" varchar(128) PRIMARY KEY, "state" jsonb NOT NULL)`);
    await query.query(`CREATE INDEX "IDX_desktop_records_scope" ON "desktop_records" ("scopeId")`);
    await query.query(`CREATE INDEX "IDX_desktop_records_host" ON "desktop_records" ("hostId")`);
  }
  async down(query: QueryRunner): Promise<void> { await query.query('DROP TABLE "desktop_connections"'); await query.query('DROP TABLE "desktop_records"'); }
}
