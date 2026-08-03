import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AppSetting } from "../settings/app-setting.entity";
import { StorageService } from "../storage/storage.service";

/** Public, admin-editable site settings (name, description, favicon, …). Stored
 *  as `site.*` string keys in the shared `app_setting` table; the favicon binary
 *  lives in object storage (MinIO/S3) and is served from a stable endpoint. */

const PREFIX = "site.";
const FAVICON_KEY = "site/favicon"; // object-storage key

/** Keys exposed publicly (read by every page for title/branding). */
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

export interface SiteFavicon {
  body: Buffer;
  contentType: string;
}

@Injectable()
export class SiteSettingsService {
  constructor(
    @InjectRepository(AppSetting) private readonly repo: Repository<AppSetting>,
    private readonly storage: StorageService,
  ) {}

  /** All `site.*` values as a plain map (keys without the prefix). */
  async getAll(): Promise<Record<string, string>> {
    const rows = await this.repo.find();
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (row.key.startsWith(PREFIX)) out[row.key.slice(PREFIX.length)] = row.value;
    }
    return out;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { key: PREFIX + key } });
    return row?.value ?? null;
  }

  /** Upsert several site settings at once. Returns the full updated map. */
  async setMany(update: Record<string, string>): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(update)) {
      await this.repo.upsert({ key: PREFIX + key, value }, ["key"]);
    }
    return this.getAll();
  }

  /** Store an uploaded favicon in object storage and record its metadata. */
  async setFavicon(body: Buffer, contentType: string): Promise<void> {
    await this.storage.put(FAVICON_KEY, body, contentType);
    await this.setMany({ faviconContentType: contentType, faviconUpdatedAt: `${Date.now()}` });
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

  /** Cache-busting version token so the browser refetches the favicon after a change. */
  async faviconVersion(): Promise<string | null> {
    return this.get("faviconUpdatedAt");
  }
}
