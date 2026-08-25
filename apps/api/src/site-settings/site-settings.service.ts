import type { SQL } from "bun";
import type { StorageService } from "../storage/storage.service";

const PREFIX = "site.";
const FAVICON_KEY = "site/favicon";

export const PUBLIC_SITE_KEYS = [
  "name",
  "description",
  "supportEmail",
  "footerText",
  "brandColor",
  "themePreset",
  "themeRadius",
  "themeOverrides",
  "termsUrl",
  "privacyUrl",
  "locale",
  "timezone",
  "maintenanceMode",
  "allowSignup",
] as const;

interface SiteSettingRow {
  key: string;
  value: string;
}

export interface SiteFavicon {
  body: Buffer;
  contentType: string;
}

export class SiteSettingsService {
  constructor(
    private readonly sql: SQL,
    private readonly storage: StorageService,
  ) {}

  async getAll(): Promise<Record<string, string>> {
    const rows = await this.sql<SiteSettingRow[]>`
      SELECT "key", "value" FROM "app_setting" WHERE "key" LIKE 'site.%'
    `;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key.slice(PREFIX.length)] = row.value;
    return result;
  }

  async get(key: string): Promise<string | null> {
    const rows = await this.sql<SiteSettingRow[]>`
      SELECT "key", "value" FROM "app_setting" WHERE "key" = ${PREFIX + key}
    `;
    return rows[0]?.value ?? null;
  }

  async setMany(update: Record<string, string>): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(update)) {
      await this.sql`
        INSERT INTO "app_setting" ("key", "value", "updatedAt")
        VALUES (${PREFIX + key}, ${value}, CURRENT_TIMESTAMP)
        ON CONFLICT ("key") DO UPDATE
        SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
      `;
    }
    return this.getAll();
  }

  async setFavicon(body: Uint8Array, contentType: string): Promise<void> {
    await this.storage.put(FAVICON_KEY, body, contentType);
    await this.setMany({
      faviconContentType: contentType,
      faviconUpdatedAt: String(Date.now()),
    });
  }

  async getFavicon(): Promise<SiteFavicon | null> {
    const contentType = await this.get("faviconContentType");
    if (!contentType) return null;
    try {
      return { body: await this.storage.get(FAVICON_KEY), contentType };
    } catch {
      return null;
    }
  }

  faviconVersion(): Promise<string | null> {
    return this.get("faviconUpdatedAt");
  }
}
