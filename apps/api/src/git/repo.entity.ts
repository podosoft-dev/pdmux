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
import { Host } from "../hosts/host.entity";

/**
 * A git checkout the agent found on a host. Read-only by construction: the agent
 * only ever runs inspection commands, and this table stores what it saw.
 */
@Entity("repos")
@Index(["hostId", "path"], { unique: true })
export class Repo {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  hostId!: string;

  @ManyToOne(() => Host, { onDelete: "CASCADE" })
  @JoinColumn({ name: "hostId" })
  host?: Host;

  /** Absolute path on the host — the checkout's stable identity. */
  @Column({ type: "varchar", length: 1024 })
  path!: string;

  @Column({ type: "varchar", length: 512 })
  name!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  headBranch!: string | null;

  @Column({ type: "varchar", length: 40, nullable: true })
  headSha!: string | null;

  @Column({ type: "boolean", default: false })
  detached!: boolean;

  @Column({ type: "int", nullable: true })
  ahead!: number | null;

  @Column({ type: "int", nullable: true })
  behind!: number | null;

  /** Uncommitted entries (staged + unstaged + untracked + conflicts). */
  @Column({ type: "int", default: 0 })
  dirtyCount!: number;

  /** Submodule pointers that moved. Counted separately because a dirty submodule
   *  is invisible in the file list yet is exactly what makes a "clean" checkout
   *  commit something unexpected. */
  @Column({ type: "int", default: 0 })
  dirtySubmodules!: number;

  /** True when older history was outside the collected window. */
  @Column({ type: "boolean", default: false })
  truncated!: boolean;

  @Column({ type: "int", default: 300 })
  limit!: number;

  /** Commits in the window whose detail has not been collected yet. The UI says
   *  "still collecting (N left)" instead of showing an error on a click. */
  @Column({ type: "int", default: 0 })
  pendingDetails!: number;

  /** Whether a working-tree patch object exists for this repo right now. */
  @Column({ type: "boolean", default: false })
  hasWorkingDiff!: boolean;

  @Column({ type: "timestamptz", nullable: true })
  lastSnapshotAt!: Date | null;

  /**
   * When this checkout first went missing from the host's report — NULL while it is
   * still being reported.
   *
   * WHY A ROW HAS TO BE ABLE TO DIE. `pruneCommits` reconciles the commits inside a
   * repo; nothing reconciled the repos themselves, so a checkout that was deleted,
   * moved, or stopped being a checkout at all stayed on the dashboard forever. Worse
   * than the stale entry is the stale ORDER: the row keeps whatever `seq` its last
   * snapshot left, and once those go NULL the graph is ordered by author date alone,
   * which ties. That is how a checkout of 54 commits and no merges came to render as
   * two lanes long after it had stopped existing on its host.
   *
   * MARK FIRST, SWEEP LATER: deleting on one absence would let a single slow or failed
   * discovery pass take a live repository's history with it. A row is dropped only
   * after it has been absent from at least two consecutive full reports AND for longer
   * than `REPO_MISSING_GRACE_MS`.
   */
  @Column({ type: "timestamptz", nullable: true })
  missingSince!: Date | null;

  /** Collection error for this repo alone — one broken checkout must not hide the
   *  other fourteen on the same host. */
  @Column({ type: "varchar", length: 512, nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;

  /**
   * The last remote check, or null when nobody has asked for one.
   *
   * ⚠ NOT `repo_refs`. Those are LOCAL pointers, including remote-TRACKING refs
   * that are as old as the last fetch a human ran; these are what the remote itself
   * answered. `remoteCheckedAt` null means never asked — a state the UI says out
   * loud rather than rendering as "up to date".
   */
  @Column({ type: "jsonb", nullable: true })
  remoteRefs!: { name: string; sha: string; kind: "branch" | "tag" }[] | null;

  @Column({ type: "timestamptz", nullable: true })
  remoteCheckedAt!: Date | null;

  /** Why the remote could not be reached — no remote, no network, no credentials. */
  @Column({ type: "varchar", length: 512, nullable: true })
  remoteError!: string | null;
}
