import { AppException } from "@podosoft/podokit-contracts";
import { PUBLIC_SITE_KEYS } from "./site-settings.service";

const ALLOWED = new Set<string>(PUBLIC_SITE_KEYS);
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

function invalid(message: string): never {
  throw new AppException("SITE_SETTING_INVALID", message, 400);
}

export function validateSiteSetting(key: string, value: string): string {
  if (!ALLOWED.has(key)) invalid(`Unknown setting: ${key}`);
  if (value === "") return "";
  if (key === "locale") {
    if (!LOCALE.test(value)) invalid("locale must be a valid BCP 47 language tag");
    try {
      return Intl.getCanonicalLocales(value)[0] ?? value;
    } catch {
      return invalid("locale must be a valid BCP 47 language tag");
    }
  }
  if (key === "brandColor") {
    if (!HEX.test(value)) invalid("brandColor must be a hex color");
  } else if (key === "themePreset") {
    if (!PRESET.test(value)) invalid("Invalid themePreset");
  } else if (key === "themeRadius") {
    const radius = Number(value);
    if (!Number.isFinite(radius) || radius < 0 || radius > 4) invalid("themeRadius must be 0–4");
    return String(radius);
  } else if (key === "themeOverrides") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return invalid("themeOverrides must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalid("themeOverrides must be an object");
    }
    const result: Record<string, Record<string, string>> = {};
    for (const mode of ["light", "dark"] as const) {
      const block = (parsed as Record<string, unknown>)[mode];
      if (block === undefined) continue;
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return invalid(`themeOverrides.${mode} must be an object`);
      }
      const clean: Record<string, string> = {};
      for (const [token, tokenValue] of Object.entries(block)) {
        if (!THEME_TOKEN_KEYS.has(token)) invalid(`Unknown theme token: ${token}`);
        if (typeof tokenValue !== "string" || !HEX.test(tokenValue)) {
          invalid(`themeOverrides.${mode}.${token} must be a hex color`);
        }
        clean[token] = tokenValue;
      }
      if (Object.keys(clean).length > 0) result[mode] = clean;
    }
    return JSON.stringify(result);
  }
  return value;
}
