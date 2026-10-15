import type { SQL } from "bun";
import type { ConfigStore } from "@podosoft/podokit-auth";
import { FEATURE_FLAGS, flagsFrom, type FeatureFlag } from "./flag-defaults";

export { FEATURE_FLAGS, type FeatureFlag };

export type SettingsSnapshot = Pick<ConfigStore, "selectSettings" | "invalidate">;

/** DB-backed feature flags with migration defaults as the source of truth. Reads
 *  come from the shared settings snapshot, so every replica follows a change
 *  within the snapshot TTL; a write here applies on this replica at once. */
export class SettingsService {
  private readonly current: () => Promise<Record<FeatureFlag, boolean>>;

  constructor(
    private readonly sql: SQL,
    private readonly snapshot: SettingsSnapshot,
    private readonly onChange: () => Promise<void> = async () => undefined,
  ) {
    this.current = snapshot.selectSettings(flagsFrom);
  }

  /** Reload the snapshot from the database. */
  async refresh(): Promise<void> {
    this.snapshot.invalidate();
    await this.current();
  }

  async getBool(flag: FeatureFlag): Promise<boolean> {
    return (await this.current())[flag];
  }

  async flags(): Promise<Record<FeatureFlag, boolean>> {
    return { ...(await this.current()) };
  }

  async setMany(update: Partial<Record<FeatureFlag, boolean>>): Promise<Record<FeatureFlag, boolean>> {
    try {
      for (const flag of FEATURE_FLAGS) {
        const value = update[flag];
        if (typeof value !== "boolean") continue;
        await this.sql`
          INSERT INTO "app_setting" ("key", "value", "updatedAt")
          VALUES (${flag}, ${String(value)}, CURRENT_TIMESTAMP)
          ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
        `;
      }
    } finally {
      // Also after a failure: earlier rows of the update may have been written.
      await this.refresh();
    }
    await this.onChange();
    return this.flags();
  }
}
