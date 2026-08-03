import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * An optional deadline on the credential an agent presents, and the place the
 * choice is parked while an enrollment code is outstanding.
 *
 * WHY `agent_tokens."expiresAt"` IS NULLABLE WHEN `host_mcp_keys` HAS IT NOT NULL —
 * this is the other half of the conversation `1730600000000-AddHostMcpKeys.ts`
 * started. That migration said an MCP key belongs to a person's tooling and dies on
 * its own; this column exists because an agent token belongs to a MACHINE, which
 * cannot renew anything by itself. A lapsed token is that host going dark, at an
 * hour nobody chose, and the recovery is a trip to the machine. So the column is
 * NULLABLE and NULL means never: every row that already exists keeps working
 * untouched, and an expiry is something a caller ASKS FOR at issue time when it is
 * minting a credential it knows is temporary.
 *
 * That split is Tailscale's, not an invention: it disables key expiry for tagged
 * server devices precisely because forced re-authentication on a server is a
 * scheduled outage, while leaving expiry on for the ephemeral case.
 *
 * `agent_enrollments."tokenExpiresInDays"` carries the choice across the gap
 * between "operator picks" and "installer redeems". The code is minted minutes
 * before the token is, and the machine redeeming it has no say in its own lifetime
 * — so the number is recorded on the code, not asked for at redemption.
 *
 * ⚠ Additive and NULL-defaulted on both tables on purpose, so it applies to a
 * running server: code that has never heard of the column ignores it, and a row
 * written before this migration reads exactly as it did.
 */
export class AddAgentTokenExpiry1730700000000 implements MigrationInterface {
  name = "AddAgentTokenExpiry1730700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_tokens" ADD COLUMN "expiresAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "agent_enrollments" ADD COLUMN "tokenExpiresInDays" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_enrollments" DROP COLUMN "tokenExpiresInDays"`);
    await queryRunner.query(`ALTER TABLE "agent_tokens" DROP COLUMN "expiresAt"`);
  }
}
