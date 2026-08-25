import type { SQL } from "bun";
import { FLAG_DEFAULTS, FEATURE_FLAGS, type FeatureFlag } from "./flag-defaults";

export { FEATURE_FLAGS, type FeatureFlag };

interface AppSettingRow {
  key: string;
  value: string;
}

/** DB-backed feature flags with migration defaults as the source of truth. */
export class SettingsService {
  private cache = new Map<string, string>();

  constructor(private readonly sql: SQL) {}

  async refresh(): Promise<void> {
    try {
      const rows = await this.sql<AppSettingRow[]>`
        SELECT "key", "value" FROM "app_setting"
      `;
      this.cache = new Map(rows.map((row) => [row.key, row.value]));
    } catch {
      this.cache = new Map();
    }
  }

  getBool(flag: FeatureFlag): boolean {
    const stored = this.cache.get(flag);
    return stored === undefined ? FLAG_DEFAULTS[flag] : stored === "true";
  }

  flags(): Record<FeatureFlag, boolean> {
    return Object.fromEntries(
      FEATURE_FLAGS.map((flag) => [flag, this.getBool(flag)]),
    ) as Record<FeatureFlag, boolean>;
  }

  async setMany(update: Partial<Record<FeatureFlag, boolean>>): Promise<Record<FeatureFlag, boolean>> {
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
    await this.refresh();
    return this.flags();
  }
}
