import { Column, Entity, PrimaryColumn } from "typeorm";
@Entity("desktop_connections")
export class DesktopConnection {
  @PrimaryColumn({ type: "varchar", length: 128 }) userId!: string;
  @Column({ type: "jsonb" }) state!: Record<string, unknown>;
}
