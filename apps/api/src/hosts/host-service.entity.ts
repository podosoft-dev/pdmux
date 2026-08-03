import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Host } from "./host.entity";
import type { Relation } from "typeorm";

export type ProbeKind = "tcp" | "http" | "none";

/**
 * One port on a host that the dashboard can open and the agent can probe.
 *
 * WHY IT IS A TABLE: the tool this generalises kept the service list hardcoded in
 * two places (the tunnel script and the dashboard generator) and they drifted —
 * a service existed but had no up/down dot, or vice versa. Here the row is the
 * single source of truth: it feeds the agent's probe config AND the card's link.
 */
@Entity("host_services")
@Index(["hostId", "label"], { unique: true })
@Index(["hostId", "sortOrder"])
export class HostService {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, (host) => host.services, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  /**
   * ⚠ `Relation<Host>`, NOT `Host`. `emitDecoratorMetadata` is on, so a bare type
   * here compiles to `Reflect.metadata("design:type", Host)` — an EAGER read of a
   * binding that is still in its temporal dead zone whenever this module is
   * reached from inside `host.entity`'s own evaluation. That is a genuine cycle
   * (`host.entity` names this entity in its `@OneToMany`), and it only stayed
   * quiet while this file happened to be required first. Adding a second entity
   * pointing at `Host` changed that order and the API refused to boot with
   * `ReferenceError: Cannot access 'Host' before initialization`. `Relation<T>`
   * exists for exactly this: it erases to `Object` in the metadata.
   */
  host?: Relation<Host>;

  /** Short name shown in the picker, e.g. "api", "admin", "term". */
  @Column({ type: "varchar", length: 64 })
  label!: string;

  @Column({ type: "int" })
  port!: number;

  @Column({ type: "varchar", length: 8, default: "tcp" })
  probe!: ProbeKind;

  /** Path used by an http probe (ignored by tcp/none). */
  @Column({ type: "varchar", length: 512, default: "/" })
  path!: string;

  /** Public URL pattern, e.g. `https://{host}-{label}.example.com`. Null means the
   *  UI builds a plain `http://{address}:{port}` link instead. */
  @Column({ type: "varchar", length: 512, nullable: true })
  urlTemplate!: string | null;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  /**
   * Off keeps the row but stops the two things a live service does: the agent
   * stops probing the port, and the card stops offering the link.
   *
   * ⚠ IT IS NOT A SOFT DELETE. Deleting also throws away the label, probe kind,
   * path and URL template somebody configured, so the cheapest way back from a
   * delete is to type it all again. This is for the service that is down for the
   * afternoon, or the container nobody is running today — the row is still the
   * truth about how to reach it once it is back.
   */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
