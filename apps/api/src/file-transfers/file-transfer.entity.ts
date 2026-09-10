import { Column, Entity, Index, PrimaryColumn } from "typeorm";

export type TransferState = "draft" | "queued" | "running" | "paused" | "ready" | "completed" | "failed" | "cancelled" | "expired";
export type TransferEntryState = "pending" | "committed" | "skipped";

@Entity("file_transfers")
@Index("IDX_file_transfers_owner", ["userId", "organizationId", "hostId"])
export class FileTransfer {
  @PrimaryColumn({ type: "uuid" }) id!: string;
  @Column({ type: "varchar", length: 128 }) userId!: string;
  @Column({ type: "varchar", length: 128 }) organizationId!: string;
  @Column({ type: "uuid" }) hostId!: string;
  @Column({ type: "varchar", length: 16 }) direction!: "upload" | "download";
  @Column({ type: "text" }) basePath!: string;
  @Column({ type: "simple-json" }) selection!: string[];
  @Column({ type: "varchar", length: 16 }) state!: TransferState;
  @Column({ type: "double precision", default: 0 }) bytes!: number;
  @Column({ type: "double precision", default: 0 }) totalBytes!: number;
  @Column({ type: "integer", default: 0 }) completedEntries!: number;
  @Column({ type: "integer", default: 0 }) totalEntries!: number;
  @Column({ type: "text", default: "" }) currentPath!: string;
  @Column({ type: "text", default: "" }) errorCode!: string;
  @Column({ type: "simple-json" }) exclusions!: string[];
  @Column({ type: "double precision", default: 0 }) archiveBytes!: number;
  @Column({ type: "text", default: "" }) etag!: string;
  @Column({ type: "double precision" }) updated!: number;
  @Column({ type: "double precision" }) created!: number;
}

@Entity("file_transfer_entries")
@Index("IDX_file_transfer_entries_path", ["transferId", "path"], { unique: true })
export class FileTransferEntry {
  @PrimaryColumn({ type: "uuid" }) id!: string;
  @Column({ type: "uuid" }) transferId!: string;
  @Column({ type: "text" }) path!: string;
  @Column({ type: "varchar", length: 16 }) kind!: "file" | "directory";
  @Column({ type: "double precision", default: 0 }) size!: number;
  @Column({ type: "double precision", default: 0 }) offset!: number;
  @Column({ type: "text", default: "" }) fingerprint!: string;
  @Column({ type: "text", default: "" }) modified!: string;
  @Column({ type: "varchar", length: 16, default: "pending" }) state!: TransferEntryState;
  @Column({ type: "boolean", default: false }) replace!: boolean;
}
