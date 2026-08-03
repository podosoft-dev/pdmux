import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The credential a coding CLI presents to reach a whole fleet.
 *
 * Same storage discipline as `host_mcp_keys`: sha256 hex, UNIQUE, so verification is
 * a single indexed read and a dump cannot be replayed; `keyPrefix` in the clear only
 * so a list can name a row; `revokedAt` a timestamp rather than a delete, because
 * `lastUsedAt` is the evidence of what a compromised token reached.
 *
 * ⚠ A SECOND TABLE RATHER THAN A NULLABLE `hostId`. `host_mcp_keys` is built around
 * "it is bound to a host, and that is the whole security model", held up by a NOT
 * NULL column and a cascading key. Relaxing that would put a discriminator in the
 * authentication hot path and give one row two mutually exclusive owners.
 *
 * ⚠ `organizationId` IS A STRING, NOT A FOREIGN KEY, because that is what
 * `resolveScopeId` answers: an organization id, or the synthetic `personal:<userId>`
 * a single-person install runs under. There is no table the second form points at —
 * which is why `hosts."organizationId"` is a plain varchar too.
 *
 * ⚠ `userId` HAS NO FOREIGN KEY EITHER, for the reason `host_mcp_keys.createdByUserId`
 * has none: `"user"` belongs to better-auth and its own migrator, and a constraint
 * across that boundary couples two release processes. A deleted or demoted user is
 * handled by re-deriving authority on every authentication, not by a cascade.
 *
 * ⚠ `tier` IS ONE VALUE, NOT AN ARRAY. `scopes text[]` suits a host key, whose
 * capabilities really are independent. A fleet tier is a ladder, and storing a ladder
 * as a set is how "admin without write" becomes representable.
 *
 * ⚠ Additive on purpose — a new table, invisible to the code running before it, so it
 * can be applied while the server is up.
 */
export class AddUserMcpKeys1731200000000 implements MigrationInterface {
  name = "AddUserMcpKeys1731200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_mcp_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizationId" character varying(128) NOT NULL,
        "userId" character varying(128) NOT NULL,
        "label" character varying(64) NOT NULL,
        "keyHash" character varying(64) NOT NULL,
        "keyPrefix" character varying(24) NOT NULL,
        "tier" character varying(16) NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_mcp_keys" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_mcp_keys_keyHash" UNIQUE ("keyHash")
      )
    `);
    // Listing is always "this person's tokens in this scope", so both columns are
    // read on the same path.
    await queryRunner.query(`CREATE INDEX "IDX_user_mcp_keys_userId" ON "user_mcp_keys" ("userId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_user_mcp_keys_organizationId" ON "user_mcp_keys" ("organizationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_user_mcp_keys_organizationId"`);
    await queryRunner.query(`DROP INDEX "IDX_user_mcp_keys_userId"`);
    await queryRunner.query(`DROP TABLE "user_mcp_keys"`);
  }
}
