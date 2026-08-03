import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Repo } from "./repo.entity";

export type RefKind = "local" | "remote" | "tag";

/**
 * A branch/tag pointer as of the last snapshot.
 *
 * ⚠ `kind: "remote"` is a remote-TRACKING ref: it is whatever the host last
 * fetched, not what the forge holds now. The collector never fetches (that would
 * write to someone's repository), so the UI has to label it as such.
 */
@Entity("repo_refs")
@Index(["repoId", "kind", "name"], { unique: true })
export class RepoRef {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  repoId!: string;

  @ManyToOne(() => Repo, { onDelete: "CASCADE" })
  @JoinColumn({ name: "repoId" })
  repo?: Repo;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 8 })
  kind!: RefKind;

  @Column({ type: "varchar", length: 40 })
  sha!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  upstream!: string | null;

  @Column({ type: "int", nullable: true })
  ahead!: number | null;

  @Column({ type: "int", nullable: true })
  behind!: number | null;

  /** Upstream branch no longer exists on the remote — a branch you can only push
   *  anew. Kept as a column (not derived) because it is the difference between
   *  "0 behind" and "there is nothing to be behind of". */
  @Column({ type: "boolean", default: false })
  gone!: boolean;
}
