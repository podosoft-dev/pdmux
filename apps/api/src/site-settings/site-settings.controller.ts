/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Public, Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { PUBLIC_SITE_KEYS, SiteSettingsService } from "./site-settings.service";

function isAdmin(session: UserSession): boolean {
  const role = session.user?.role;
  const roles = Array.isArray(role) ? role : (role ?? "").split(",").map((r: string) => r.trim());
  return roles.includes("admin");
}

const ALLOWED = new Set<string>(PUBLIC_SITE_KEYS);
const MAX_ICON_BYTES = 1024 * 1024; // 1 MB
const ICON_TYPES = new Set(["image/svg+xml", "image/png", "image/x-icon", "image/vnd.microsoft.icon"]);

// Theme values are injected into a client-side <style>, so validate them to
// prevent CSS injection. Colors must be hex, radius a bounded rem number,
// preset a slug, and overrides a JSON map of hex colors under known token keys.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PRESET = /^[a-z0-9-]{1,32}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const THEME_TOKEN_KEYS = new Set([
  "background",
  "card",
  "foreground",
  "mutedForeground",
  "border",
  "secondary",
  "accent",
  "primary",
  "primaryForeground",
]);

/** Validate/normalize a single theme setting value. Empty string clears it. */
function validateThemeValue(key: string, value: string): string {
  if (value === "") return "";
  if (key === "locale") {
    if (!LOCALE.test(value)) throw new BadRequestException("locale must be a valid BCP 47 language tag");
    try {
      return Intl.getCanonicalLocales(value)[0] ?? value;
    } catch {
      throw new BadRequestException("locale must be a valid BCP 47 language tag");
    }
  }
  if (key === "brandColor") {
    if (!HEX.test(value)) throw new BadRequestException("brandColor must be a hex color");
    return value;
  }
  if (key === "themePreset") {
    if (!PRESET.test(value)) throw new BadRequestException("Invalid themePreset");
    return value;
  }
  if (key === "themeRadius") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 4) throw new BadRequestException("themeRadius must be 0–4");
    return String(n);
  }
  if (key === "themeOverrides") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException("themeOverrides must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object") throw new BadRequestException("themeOverrides must be an object");
    const out: Record<string, Record<string, string>> = {};
    for (const mode of ["light", "dark"] as const) {
      const block = (parsed as Record<string, unknown>)[mode];
      if (block === undefined) continue;
      if (!block || typeof block !== "object") throw new BadRequestException(`themeOverrides.${mode} must be an object`);
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        if (!THEME_TOKEN_KEYS.has(k)) throw new BadRequestException(`Unknown theme token: ${k}`);
        if (typeof v !== "string" || !HEX.test(v)) throw new BadRequestException(`themeOverrides.${mode}.${k} must be a hex color`);
        clean[k] = v;
      }
      if (Object.keys(clean).length) out[mode] = clean;
    }
    return JSON.stringify(out);
  }
  return value;
}

@ApiTags("site")
@Controller("site")
export class SiteSettingsController {
  constructor(private readonly site: SiteSettingsService) {}

  /** Public: the site branding every page needs (title, favicon presence, …). */
  @Public()
  @Get("settings")
  async settings(): Promise<Record<string, string | boolean | null>> {
    const all = await this.site.getAll();
    const out: Record<string, string | boolean | null> = {};
    for (const key of PUBLIC_SITE_KEYS) out[key] = all[key] ?? null;
    out.hasFavicon = (await this.site.get("faviconContentType")) !== null;
    out.faviconVersion = await this.site.faviconVersion();
    return out;
  }

  /** Admin: update one or more site settings. Unknown keys are rejected. */
  @Put("settings")
  async update(
    @Session() session: UserSession,
    @Body() body: Record<string, string>,
  ): Promise<Record<string, string>> {
    if (!isAdmin(session)) throw new ForbiddenException("Admins only");
    const update: Record<string, string> = {};
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!ALLOWED.has(key)) throw new BadRequestException(`Unknown setting: ${key}`);
      update[key] = validateThemeValue(key, String(value ?? ""));
    }
    return this.site.setMany(update);
  }

  /** Admin: upload the browser icon. Stored in object storage; served below. */
  @Post("favicon")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file"))
  async uploadFavicon(
    @Session() session: UserSession,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ version: string | null }> {
    if (!isAdmin(session)) throw new ForbiddenException("Admins only");
    if (!file) throw new BadRequestException("A file field is required (multipart/form-data)");
    if (!ICON_TYPES.has(file.mimetype)) {
      throw new BadRequestException("Icon must be SVG, PNG, or ICO");
    }
    if (file.size > MAX_ICON_BYTES) throw new BadRequestException("Icon must be 1 MB or smaller");
    await this.site.setFavicon(file.buffer, file.mimetype);
    return { version: await this.site.faviconVersion() };
  }

  /** Public: serve the current favicon from object storage (stable URL, no expiry). */
  @Public()
  @Get("favicon")
  async favicon(): Promise<StreamableFile> {
    const icon = await this.site.getFavicon();
    if (!icon) throw new BadRequestException("No favicon set");
    return new StreamableFile(icon.body, { type: icon.contentType });
  }
}
