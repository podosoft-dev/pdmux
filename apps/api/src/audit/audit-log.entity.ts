import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

// An append-only audit trail. Fields follow the actor / action / target model:
// who did what, to which resource, when — with human-readable labels stored
// inline so entries stay meaningful even after users are renamed or deleted.
@Entity("audit_logs")
export class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // A stable, semantic action code, e.g. "user.create", "auth.login".
  @Index()
  @Column({ type: "varchar", length: 128 })
  action!: string;

  // Who performed it (denormalized display fields + id).
  @Column({ type: "varchar", nullable: true })
  actorId!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorName!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorEmail!: string | null;

  // What it acted on (optional).
  @Column({ type: "varchar", nullable: true })
  targetType!: string | null;

  @Column({ type: "varchar", nullable: true })
  targetId!: string | null;

  @Column({ type: "varchar", nullable: true })
  targetLabel!: string | null;

  @Column({ type: "varchar", nullable: true })
  ip!: string | null;

  // Free-form context for custom events.
  @Column({ type: "jsonb", nullable: true })
  metadata!: Record<string, unknown> | null;

  @Index()
  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
