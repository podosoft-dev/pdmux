import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Host } from "../hosts/host.entity";

/**
 * Per-user, per-host card settings (which widgets that card shows).
 *
 * Deliberately not on the host row: two people watching the same machine want
 * different cards, and the previous tool's per-card toggles were per-browser.
 */
@Entity("user_host_prefs")
@Index(["userId", "hostId"], { unique: true })
export class UserHostPref {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  userId!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  host?: Host;

  /** Opaque widget map, e.g. `{ "agents": true, "resources": false }`. */
  @Column({ type: "jsonb" })
  widgets!: Record<string, unknown>;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
