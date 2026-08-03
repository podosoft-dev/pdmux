import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Enrollment codes: the short-lived, single-use ticket the public installer
 * exchanges for a host token (see agent-enrollment.entity.ts for the why).
 *
 * The partial unique index is the load-bearing part. "At most one live code per
 * host" enforced in the service is a check-then-insert that two admin clicks race
 * straight past; here the second insert simply fails.
 */
export class InitAgentEnrollments1730100000000 implements MigrationInterface {
  name = "InitAgentEnrollments1730100000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_enrollments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostId" uuid NOT NULL,
        "codeHash" character varying(64) NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumedAt" TIMESTAMP WITH TIME ZONE,
        "consumedIp" character varying(45),
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "tokenId" uuid,
        "createdByUserId" character varying(128),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_enrollments_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_agent_enrollments_code" UNIQUE ("codeHash"),
        CONSTRAINT "FK_agent_enrollments_host" FOREIGN KEY ("hostId")
          REFERENCES "hosts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agent_enrollments_token" FOREIGN KEY ("tokenId")
          REFERENCES "agent_tokens"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_agent_enrollments_host" ON "agent_enrollments" ("hostId")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_agent_enrollments_live" ON "agent_enrollments" ("hostId")
      WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "agent_enrollments"`);
  }
}
