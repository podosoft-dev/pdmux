import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/** A single admin-editable application setting, stored as a string key/value.
 *  Feature flags (twoFactor, magicLink, ...) live here so an admin can change
 *  them from the UI instead of editing environment variables. */
@Entity({ name: "app_setting" })
export class AppSetting {
  @PrimaryColumn({ type: "text" })
  key!: string;

  @Column({ type: "text" })
  value!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
