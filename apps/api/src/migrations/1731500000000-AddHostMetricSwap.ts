import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Swap, alongside the CPU/memory/disk columns this table already keeps.
 *
 * ⚠ NULLABLE, AND `swapPct` IS 0 — NOT NULL — ON A HOST WITH SWAP TURNED OFF.
 * That host measured fine: nothing is swapped because there is nowhere to swap
 * to. `null` in this table means "nobody could look", and it has to keep meaning
 * only that, because it is also what every row written before this migration
 * holds and what an agent older than 0.1.16 produces. The two are told apart by
 * the byte columns: 0/0 is a swapless host, null/null is an unanswered one.
 *
 * ⚠ AND NOTHING IS BACKFILLED. Existing rows stay null because nobody was asked;
 * inventing a measurement for them would draw a flat line across history that no
 * agent ever reported, and the sparkline breaks its line at a null precisely so
 * that gap stays visible.
 */
export class AddHostMetricSwap1731500000000 implements MigrationInterface {
  name = "AddHostMetricSwap1731500000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "host_metric_samples" ADD "swapPct" smallint`);
    await queryRunner.query(`ALTER TABLE "host_metric_samples" ADD "swapUsedBytes" bigint`);
    await queryRunner.query(`ALTER TABLE "host_metric_samples" ADD "swapTotalBytes" bigint`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "host_metric_samples" DROP COLUMN "swapTotalBytes"`);
    await queryRunner.query(`ALTER TABLE "host_metric_samples" DROP COLUMN "swapUsedBytes"`);
    await queryRunner.query(`ALTER TABLE "host_metric_samples" DROP COLUMN "swapPct"`);
  }
}
