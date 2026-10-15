import type { SQL } from "bun";
import type { ObjectData, ObjectStore } from "@podosoft/podokit-runtime";

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
  object: ObjectData;
  /** The type validated on upload. */
  contentType: string;
  /** The `faviconUpdatedAt` setting that pages put in the favicon URL. */
  version: string | null;
}

// Every page render reads the site settings, so one short-lived snapshot serves
// concurrent renders. Writes on this replica clear it immediately; another
// replica sees the change within this window.
const SNAPSHOT_TTL_MS = 3_000;

interface Snapshot {
  values: Record<string, string>;
  expiresAt: number;
}

export class SiteSettingsService {
  private snapshot: Snapshot | null = null;
  private pending: Promise<Record<string, string>> | null = null;
  private generation = 0;

  constructor(
    private readonly sql: SQL,
    private readonly storage: ObjectStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every `site.*` setting, keyed without the prefix. */
  async getAll(): Promise<Record<string, string>> {
    const snapshot = this.snapshot;
    if (snapshot && snapshot.expiresAt > this.now()) return { ...snapshot.values };
    return { ...(await this.load()) };
  }

  async get(key: string): Promise<string | null> {
    return (await this.getAll())[key] ?? null;
  }

  async setMany(update: Record<string, string>): Promise<Record<string, string>> {
    const entries = Object.entries(update);
    if (entries.length > 0) {
      try {
        await this.sql.begin(async (tx) => {
          for (const [key, value] of entries) {
            await tx`
              INSERT INTO "app_setting" ("key", "value", "updatedAt")
              VALUES (${PREFIX + key}, ${value}, CURRENT_TIMESTAMP)
              ON CONFLICT ("key") DO UPDATE
              SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
            `;
          }
        });
      } finally {
        // Also after a failure: the outcome of an interrupted commit is unknown.
        this.invalidate();
      }
    }
    return this.getAll();
  }

  async setFavicon(body: Uint8Array, contentType: string): Promise<void> {
    await this.storage.put(FAVICON_KEY, body, { contentType });
    await this.setMany({
      faviconContentType: contentType,
      faviconUpdatedAt: String(Date.now()),
    });
  }

  /** The favicon with its content unread, or null when none is set. */
  async getFavicon(): Promise<SiteFavicon | null> {
    const settings = await this.getAll();
    const contentType = settings.faviconContentType;
    if (!contentType) return null;
    const object = await this.storage.get(FAVICON_KEY);
    return object ? { object, contentType, version: settings.faviconUpdatedAt ?? null } : null;
  }

  faviconVersion(): Promise<string | null> {
    return this.get("faviconUpdatedAt");
  }

  /** One query at a time; concurrent readers share it. */
  private load(): Promise<Record<string, string>> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.query()
      .then((values) => {
        // A write that finished meanwhile may not be in these rows.
        if (generation === this.generation) {
          this.snapshot = { values, expiresAt: this.now() + SNAPSHOT_TTL_MS };
        }
        return values;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }

  private invalidate(): void {
    this.generation += 1;
    this.snapshot = null;
    this.pending = null;
  }

  private async query(): Promise<Record<string, string>> {
    const rows = await this.sql<SiteSettingRow[]>`
      SELECT "key", "value" FROM "app_setting" WHERE "key" LIKE 'site.%'
    `;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key.slice(PREFIX.length)] = row.value;
    return result;
  }
}
