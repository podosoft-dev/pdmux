import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A saved dashboard arrangement, owned by one user.
 *
 * WHY SERVER-SIDE: the tool this generalises kept the layout in localStorage, so
 * the same person on a second machine (or after clearing site data) got an empty
 * screen and rebuilt the grid by hand. The payload stays opaque JSON — the grid's
 * shape belongs to the UI and evolves faster than a migration can follow.
 */
@Entity("user_layouts")
@Index(["userId", "name"], { unique: true })
export class UserLayout {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  userId!: string;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  /** Exactly one default per user is enforced by the service, not the schema —
   *  a partial unique index would make "switch the default" a two-statement dance. */
  @Column({ type: "boolean", default: false })
  isDefault!: boolean;

  @Column({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
