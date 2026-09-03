import type { MigrationInterface, QueryRunner } from "typeorm";

/** Provider-neutral storage for fleet integrations, host connectors, and service routes. */
export class AddServiceExposures1731600000000 implements MigrationInterface {
  name = "AddServiceExposures1731600000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hosts" ADD "connectorCapabilities" jsonb NOT NULL DEFAULT '{"cloudflared":false}'::jsonb`);
    await queryRunner.query(`
      CREATE TABLE "integration_connections" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizationId" varchar(128) NOT NULL,
        "provider" varchar(32) NOT NULL,
        "config" jsonb NOT NULL,
        "secret" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_connections" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_integration_connections_scope_provider" UNIQUE ("organizationId", "provider")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "host_connectors" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "integrationId" uuid NOT NULL,
        "organizationId" varchar(128) NOT NULL,
        "hostId" uuid NOT NULL,
        "provider" varchar(32) NOT NULL,
        "externalId" varchar(128) NOT NULL,
        "name" varchar(255) NOT NULL,
        "secret" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_host_connectors" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_host_connectors_host_provider" UNIQUE ("hostId", "provider"),
        CONSTRAINT "FK_host_connectors_integration" FOREIGN KEY ("integrationId") REFERENCES "integration_connections"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_host_connectors_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "service_exposures" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "integrationId" uuid NOT NULL,
        "connectorId" uuid NOT NULL,
        "organizationId" varchar(128) NOT NULL,
        "hostId" uuid NOT NULL,
        "serviceId" uuid NOT NULL,
        "provider" varchar(32) NOT NULL,
        "hostname" varchar(253) NOT NULL,
        "mode" varchar(16) NOT NULL,
        "originScheme" varchar(8) NOT NULL,
        "noTlsVerify" boolean NOT NULL DEFAULT false,
        "status" varchar(16) NOT NULL,
        "externalDnsRecordId" varchar(128),
        "externalAccessAppId" varchar(128),
        "errorCode" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_service_exposures" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_service_exposures_service_provider" UNIQUE ("serviceId", "provider"),
        CONSTRAINT "CHK_service_exposures_mode" CHECK ("mode" IN ('access', 'public')),
        CONSTRAINT "CHK_service_exposures_origin_scheme" CHECK ("originScheme" IN ('http', 'https')),
        CONSTRAINT "CHK_service_exposures_status" CHECK ("status" IN ('pending', 'protected', 'public', 'error')),
        CONSTRAINT "FK_service_exposures_integration" FOREIGN KEY ("integrationId") REFERENCES "integration_connections"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_service_exposures_connector" FOREIGN KEY ("connectorId") REFERENCES "host_connectors"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_service_exposures_host" FOREIGN KEY ("hostId") REFERENCES "hosts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_service_exposures_service" FOREIGN KEY ("serviceId") REFERENCES "host_services"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_host_connectors_integration" ON "host_connectors" ("integrationId")`);
    await queryRunner.query(`CREATE INDEX "IDX_service_exposures_integration" ON "service_exposures" ("integrationId")`);
    await queryRunner.query(`CREATE INDEX "IDX_service_exposures_connector" ON "service_exposures" ("connectorId")`);
    await queryRunner.query(`CREATE INDEX "IDX_service_exposures_scope_provider" ON "service_exposures" ("organizationId", "provider")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "service_exposures"`);
    await queryRunner.query(`DROP TABLE "host_connectors"`);
    await queryRunner.query(`DROP TABLE "integration_connections"`);
    await queryRunner.query(`ALTER TABLE "hosts" DROP COLUMN "connectorCapabilities"`);
  }
}
