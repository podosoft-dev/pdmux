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

/**
 * One directory a host's agent scans for git checkouts.
 *
 * WHY IT IS PER HOST: the value is an absolute path ON THAT MACHINE. It was a
 * fleet-wide list, and a fleet-wide list of machine-specific paths is only right
 * when every machine has the same layout — the first one that does not reports
 * `git.root_missing` for ever, and the dashboard shows it no repositories with no
 * way to tell that apart from "nothing configured".
 *
 * ⚠ A ROOT IS NOT A REPOSITORY. The agent walks one level each way from here: the
 * directory is either a checkout itself or a directory OF checkouts (plus each
 * checkout's submodules). It is not a recursive search, which is why the UI says
 * so at the point of entry — otherwise people type `/Users/you` and wait.
 */
@Entity("host_git_roots")
@Index(["hostId", "path"], { unique: true })
@Index(["hostId", "sortOrder"])
export class HostGitRoot {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  /** `Relation<Host>` for the cycle reason recorded in `host-service.entity.ts`. */
  host?: Relation<Host>;

  /** Absolute path on the host, e.g. `/home/dev/work`. */
  @Column({ type: "varchar", length: 1024 })
  path!: string;

  /**
   * Off stops the agent scanning this root without losing the path.
   *
   * ⚠ NOT A SOFT DELETE, for the same reason `host_services.enabled` is not: a
   * path somebody worked out once is worth keeping while a checkout is moved or a
   * disk is unmounted. Deleting is still the right answer for a path that was
   * simply wrong.
   */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
