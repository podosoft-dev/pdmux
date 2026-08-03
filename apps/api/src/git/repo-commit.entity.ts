import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Repo } from "./repo.entity";

/**
 * One row of the commit graph — and nothing more.
 *
 * The message body, file list and patch live in object storage, fetched when a
 * commit is clicked. They were 58% of the feed when they travelled with the list
 * (measured on the tool this replaces) and none of it is rendered before a click.
 */
@Entity("repo_commits")
@Index(["repoId", "sha"], { unique: true })
@Index(["repoId", "date"])
@Index(["repoId", "seq"])
export class RepoCommit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  repoId!: string;

  @ManyToOne(() => Repo, { onDelete: "CASCADE" })
  @JoinColumn({ name: "repoId" })
  repo?: Repo;

  @Column({ type: "varchar", length: 40 })
  sha!: string;

  /**
   * Position in the window the agent reported — its index in the snapshot's
   * `commits` array, which IS `git log --date-order`.
   *
   * ⚠ THIS, NOT `date`, IS THE RENDER ORDER. `date` is the AUTHOR date (`%at`);
   * `--date-order` walks by COMMITTER date, and the two disagree for every commit
   * that kept its author date through a rebase, amend, cherry-pick or
   * `reset --soft` + re-commit. Re-deriving the order from `date` put a parent
   * ahead of its child, and the lane algorithm reads a parent nothing is waiting
   * for as a branch tip: a 60-commit linear history drew as three branches. The
   * order the agent already applied is the authority; it is stored, not guessed.
   *
   * NULL means no window has placed this row: collected before this column
   * existed, or scrolled past by a `truncated` window that no longer reaches it.
   * Those sort AFTER the window (`seq ASC NULLS LAST, date DESC`) so they never
   * interleave with it — see `GitService.graph`.
   */
  @Column({ type: "int", nullable: true })
  seq!: number | null;

  @Column({ type: "text", array: true, default: () => "'{}'" })
  parents!: string[];

  /** Decorations ("HEAD -> main", "origin/main"). These MOVE, so unlike the rest
   *  of the row they are refreshed on every snapshot. */
  @Column({ type: "text", array: true, default: () => "'{}'" })
  refs!: string[];

  @Column({ type: "varchar", length: 255, default: "" })
  author!: string;

  @Column({ type: "timestamptz", nullable: true })
  date!: Date | null;

  @Column({ type: "varchar", length: 1024, default: "" })
  subject!: string;

  /** Detail object exists in storage for this sha. Once true, never false again —
   *  a commit's patch cannot change. */
  @Column({ type: "boolean", default: false })
  hasDetail!: boolean;

  /** A merge shown against its first parent usually has an empty patch. Recording
   *  that fact is what stops it being recollected on every pass forever. */
  @Column({ type: "boolean", default: false })
  detailEmpty!: boolean;
}
