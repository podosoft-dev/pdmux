import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pdmux domain schema: hosts + services, agent tokens, metric samples, read-only
 * git snapshots, per-user personalisation and organization settings.
 *
 * Foreign keys cascade from `hosts` on purpose: deleting a host must not leave
 * orphan metric rows or repo trees that no query can ever reach again.
 */
export class InitFleet1730000000000 implements MigrationInterface {
  name = "InitFleet1730000000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "fleet_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizationId" character varying(128) NOT NULL,
        "key" character varying(64) NOT NULL,
        "value" text NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_fleet_settings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_fleet_settings_org_key" ON "fleet_settings" ("organizationId", "key")`,
    );

    await queryRunner.query(`
      CREATE TABLE "hosts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizationId" character varying(128) NOT NULL,
        "label" character varying(64) NOT NULL,
        "address" character varying(255),
        "description" character varying(512),
        "tags" text array NOT NULL DEFAULT '{}',
        "sortOrder" integer NOT NULL DEFAULT 0,
        "enabled" boolean NOT NULL DEFAULT true,
        "agentVersion" character varying(32),
        "os" character varying(64),
        "arch" character varying(32),
        "capabilities" text array NOT NULL DEFAULT '{}',
        "lastSeenAt" TIMESTAMP WITH TIME ZONE,
        "lastHeartbeat" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hosts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_hosts_org_label" ON "hosts" ("organizationId", "label")`);
    await queryRunner.query(`CREATE INDEX "IDX_hosts_org_sort" ON "hosts" ("organizationId", "sortOrder")`);

    await queryRunner.query(`
      CREATE TABLE "host_services" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostId" uuid NOT NULL,
        "label" character varying(64) NOT NULL,
        "port" integer NOT NULL,
        "probe" character varying(8) NOT NULL DEFAULT 'tcp',
        "path" character varying(512) NOT NULL DEFAULT '/',
        "urlTemplate" character varying(512),
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_host_services_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_host_services_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_host_services_host_label" ON "host_services" ("hostId", "label")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_host_services_host_sort" ON "host_services" ("hostId", "sortOrder")`);

    await queryRunner.query(`
      CREATE TABLE "agent_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostId" uuid NOT NULL,
        "name" character varying(64) NOT NULL,
        "tokenHash" character varying(64) NOT NULL,
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_tokens_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_agent_tokens_hash" UNIQUE ("tokenHash"),
        CONSTRAINT "FK_agent_tokens_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_agent_tokens_host" ON "agent_tokens" ("hostId")`);

    await queryRunner.query(`
      CREATE TABLE "host_metric_samples" (
        "id" BIGSERIAL NOT NULL,
        "hostId" uuid NOT NULL,
        "ts" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cpuPct" smallint,
        "memPct" smallint,
        "diskPct" smallint,
        "memUsedBytes" bigint,
        "memTotalBytes" bigint,
        "diskUsedBytes" bigint,
        "diskTotalBytes" bigint,
        CONSTRAINT "PK_host_metric_samples_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_host_metric_samples_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_host_metric_samples_host_ts" ON "host_metric_samples" ("hostId", "ts")`,
    );

    await queryRunner.query(`
      CREATE TABLE "repos" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostId" uuid NOT NULL,
        "path" character varying(1024) NOT NULL,
        "name" character varying(512) NOT NULL,
        "headBranch" character varying(255),
        "headSha" character varying(40),
        "detached" boolean NOT NULL DEFAULT false,
        "ahead" integer,
        "behind" integer,
        "dirtyCount" integer NOT NULL DEFAULT 0,
        "dirtySubmodules" integer NOT NULL DEFAULT 0,
        "truncated" boolean NOT NULL DEFAULT false,
        "limit" integer NOT NULL DEFAULT 300,
        "pendingDetails" integer NOT NULL DEFAULT 0,
        "hasWorkingDiff" boolean NOT NULL DEFAULT false,
        "lastSnapshotAt" TIMESTAMP WITH TIME ZONE,
        "error" character varying(512),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_repos_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_repos_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_repos_host_path" ON "repos" ("hostId", "path")`);

    await queryRunner.query(`
      CREATE TABLE "repo_refs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "repoId" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "kind" character varying(8) NOT NULL,
        "sha" character varying(40) NOT NULL,
        "upstream" character varying(255),
        "ahead" integer,
        "behind" integer,
        "gone" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_repo_refs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_repo_refs_repo" FOREIGN KEY ("repoId") REFERENCES "repos"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_repo_refs_repo_kind_name" ON "repo_refs" ("repoId", "kind", "name")`,
    );

    await queryRunner.query(`
      CREATE TABLE "repo_commits" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "repoId" uuid NOT NULL,
        "sha" character varying(40) NOT NULL,
        "parents" text array NOT NULL DEFAULT '{}',
        "refs" text array NOT NULL DEFAULT '{}',
        "author" character varying(255) NOT NULL DEFAULT '',
        "date" TIMESTAMP WITH TIME ZONE,
        "subject" character varying(1024) NOT NULL DEFAULT '',
        "hasDetail" boolean NOT NULL DEFAULT false,
        "detailEmpty" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_repo_commits_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_repo_commits_repo" FOREIGN KEY ("repoId") REFERENCES "repos"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_repo_commits_repo_sha" ON "repo_commits" ("repoId", "sha")`);
    await queryRunner.query(`CREATE INDEX "IDX_repo_commits_repo_date" ON "repo_commits" ("repoId", "date")`);

    await queryRunner.query(`
      CREATE TABLE "user_layouts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" character varying(128) NOT NULL,
        "name" character varying(64) NOT NULL,
        "isDefault" boolean NOT NULL DEFAULT false,
        "payload" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_layouts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_user_layouts_user_name" ON "user_layouts" ("userId", "name")`);

    await queryRunner.query(`
      CREATE TABLE "user_host_prefs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" character varying(128) NOT NULL,
        "hostId" uuid NOT NULL,
        "widgets" jsonb NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_host_prefs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_host_prefs_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_user_host_prefs_user_host" ON "user_host_prefs" ("userId", "hostId")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_host_prefs"`);
    await queryRunner.query(`DROP TABLE "user_layouts"`);
    await queryRunner.query(`DROP TABLE "repo_commits"`);
    await queryRunner.query(`DROP TABLE "repo_refs"`);
    await queryRunner.query(`DROP TABLE "repos"`);
    await queryRunner.query(`DROP TABLE "host_metric_samples"`);
    await queryRunner.query(`DROP TABLE "agent_tokens"`);
    await queryRunner.query(`DROP TABLE "host_services"`);
    await queryRunner.query(`DROP TABLE "hosts"`);
    await queryRunner.query(`DROP TABLE "fleet_settings"`);
  }
}
