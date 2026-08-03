import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

/**
 * Per-organization knobs that steer already-installed agents (collection
 * intervals, git window) and the server's own retention.
 *
 * WHY KEY/VALUE ROWS: these settings grow one key at a time as collectors learn
 * new limits, and an install must keep working when a key it has never heard of
 * appears (or disappears). A wide table would need a migration per knob; a
 * key/value table with typed defaults in code needs none, and an unknown row is
 * simply ignored.
 */
@Entity("fleet_settings")
@Index(["organizationId", "key"], { unique: true })
export class FleetSetting {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  organizationId!: string;

  @Column({ type: "varchar", length: 64 })
  key!: string;

  @Column({ type: "text" })
  value!: string;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
