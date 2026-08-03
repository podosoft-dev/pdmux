import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The credential a coding CLI presents to the MCP endpoint, on behalf of one host.
 *
 * ⚠ ONLY THE HASH IS STORED. `keyHash` is sha256 hex and is UNIQUE, so verification
 * is a single indexed read and a database dump cannot be replayed. `keyPrefix` is the
 * few leading characters kept in the clear purely so a list can name a row — never
 * enough to reconstruct anything.
 *
 * WHY `expiresAt` IS NOT NULL WHEN `agent_tokens` HAS NO SUCH COLUMN: an agent token
 * belongs to a machine that would go dark if its credential lapsed, and rotating it is
 * an operator action with a rollout. This one belongs to a person's tooling, is minted
 * in two clicks, and is the kind of secret that ends up in a shell history — so it dies
 * on its own.
 *
 * `revokedAt` is a timestamp rather than a delete: `lastUsedAt` is the evidence of what
 * a compromised key actually reached, and deleting the row destroys it.
 *
 * ⚠ Additive on purpose — a new table, invisible to the code running before it, so it
 * can be applied while the server is up.
 */
export class AddHostMcpKeys1730600000000 implements MigrationInterface {
  name = "AddHostMcpKeys1730600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "host_mcp_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostId" uuid NOT NULL,
        "label" character varying(64) NOT NULL,
        "keyHash" character varying(64) NOT NULL,
        "keyPrefix" character varying(24) NOT NULL,
        "scopes" text array NOT NULL DEFAULT ARRAY['read','write']::text[],
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "createdByUserId" character varying(128),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_host_mcp_keys" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_host_mcp_keys_keyHash" UNIQUE ("keyHash")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_host_mcp_keys_hostId" ON "host_mcp_keys" ("hostId")`);
    // The host is the scope, so a deleted host must take its keys with it — a key
    // pointing at nothing is a credential nobody can see to revoke.
    await queryRunner.query(`
      ALTER TABLE "host_mcp_keys"
      ADD CONSTRAINT "FK_host_mcp_keys_hostId" FOREIGN KEY ("hostId")
      REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "host_mcp_keys" DROP CONSTRAINT "FK_host_mcp_keys_hostId"`);
    await queryRunner.query(`DROP INDEX "IDX_host_mcp_keys_hostId"`);
    await queryRunner.query(`DROP TABLE "host_mcp_keys"`);
  }
}
