import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";
import type { SyncRecord } from "@pdmux/desktop-protocol";

@Entity("desktop_records")
@Index("IDX_desktop_records_scope", ["scopeId"])
@Index("IDX_desktop_records_host", ["hostId"])
export class DesktopRecord {
  @PrimaryColumn({ type: "varchar", length: 64 }) id!: string;
  @Column({ type: "varchar", length: 256 }) scopeId!: string;
  @Column({ type: "varchar", length: 128 }) userId!: string;
  @Column({ type: "varchar", length: 256 }) key!: string;
  @Column({ type: "varchar", length: 32 }) kind!: SyncRecord["kind"];
  @Column({ type: "varchar", length: 128 }) origin!: string;
  @Column({ type: "varchar", length: 1024, default: "" }) connectionKey!: string;
  @Column({ type: "uuid", nullable: true }) hostId!: string | null;
  @Column({ type: "jsonb", nullable: true }) value!: Record<string, unknown> | null;
  @Column({ type: "jsonb", nullable: true }) cachedView!: Record<string, unknown> | null;
  @UpdateDateColumn({ type: "timestamptz" }) updatedAt!: Date;
}
