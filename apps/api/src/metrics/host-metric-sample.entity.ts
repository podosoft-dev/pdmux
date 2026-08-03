import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * One stored resource sample for a host.
 *
 * WHY NOT EVERY HEARTBEAT: heartbeats arrive every few seconds (5 by default);
 * storing each one is ~17k rows per host per day to draw a graph whose points are
 * 30s apart. The writer downsamples to `metricStepSec` and a repeatable job drops
 * anything older than the retention setting — this table replaces the fixed
 * one-hour JSON ring the previous tool kept on disk.
 */
@Entity("host_metric_samples")
@Index(["hostId", "ts"])
export class HostMetricSample {
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  /** Sample time as reported by the agent (UTC). */
  @Column({ type: "timestamptz" })
  ts!: Date;

  @Column({ type: "smallint", nullable: true })
  cpuPct!: number | null;

  @Column({ type: "smallint", nullable: true })
  memPct!: number | null;

  @Column({ type: "smallint", nullable: true })
  diskPct!: number | null;

  // Absolute bytes travel with the percentages: a tooltip wants "12Gi/30Gi" and a
  // percentage alone cannot produce it. bigint columns come back as strings from
  // pg, so the read path converts them once, at the edge.
  @Column({ type: "bigint", nullable: true })
  memUsedBytes!: string | null;

  @Column({ type: "bigint", nullable: true })
  memTotalBytes!: string | null;

  @Column({ type: "bigint", nullable: true })
  diskUsedBytes!: string | null;

  @Column({ type: "bigint", nullable: true })
  diskTotalBytes!: string | null;
}
