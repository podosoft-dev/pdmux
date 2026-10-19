import type { MigrationInterface, QueryRunner } from "typeorm";

/** VM platform connections and the machine behind a host, with its one operation in flight. */
export class AddVmProviders1792400000000 implements MigrationInterface {
  name = "AddVmProviders1792400000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vm_providers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizationId" varchar(128) NOT NULL,
        "kind" varchar(32) NOT NULL,
        "name" varchar(64) NOT NULL,
        "config" jsonb NOT NULL,
        "secret" text NOT NULL,
        "lastTestedAt" timestamptz,
        "lastErrorCode" varchar(64),
        "reconcileLeaseUntil" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vm_providers" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_vm_providers_kind" CHECK ("kind" IN ('proxmox'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_vm_providers_scope_name" ON "vm_providers" ("organizationId", "name")`);
    await queryRunner.query(`
      CREATE TABLE "host_vms" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizationId" varchar(128) NOT NULL,
        "hostId" uuid NOT NULL,
        "providerId" uuid NOT NULL,
        "location" varchar(64) NOT NULL,
        "externalId" varchar(128) NOT NULL,
        "name" varchar(128) NOT NULL,
        "origin" varchar(16) NOT NULL,
        "spec" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "observedState" varchar(16) NOT NULL DEFAULT 'unknown',
        "observedAt" timestamptz,
        "operation" varchar(16),
        "operationStep" varchar(32),
        "operationTask" varchar(255),
        "operationRequestedById" varchar(128),
        "operationRequestedByName" varchar(255),
        "operationStartedAt" timestamptz,
        "operationUpdatedAt" timestamptz,
        "errorCode" varchar(64),
        "errorAt" timestamptz,
        "idempotencyKey" varchar(64),
        "version" integer NOT NULL DEFAULT 1,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_host_vms" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_host_vms_origin" CHECK ("origin" IN ('created', 'linked')),
        CONSTRAINT "CHK_host_vms_state" CHECK ("observedState" IN ('running', 'hibernated', 'stopped', 'paused', 'unknown', 'missing')),
        CONSTRAINT "CHK_host_vms_operation" CHECK ("operation" IS NULL OR "operation" IN ('start', 'hibernate', 'shutdown', 'stop', 'reboot', 'reset', 'create', 'delete', 'enroll')),
        CONSTRAINT "FK_host_vms_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_host_vms_provider" FOREIGN KEY ("providerId") REFERENCES "vm_providers"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_host_vms_host" ON "host_vms" ("hostId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_host_vms_provider_external" ON "host_vms" ("providerId", "externalId")`);
    await queryRunner.query(`CREATE INDEX "IDX_host_vms_scope" ON "host_vms" ("organizationId")`);
    // A retried create with the same key finds the first one, across replicas too.
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_host_vms_idempotency" ON "host_vms" ("organizationId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "host_vms"`);
    await queryRunner.query(`DROP TABLE "vm_providers"`);
  }
}
