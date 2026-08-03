// Computes the effective theme (preset neutrals ⊕ brand-color accent ⊕ radius ⊕
// per-token overrides) and applies it. Two outputs share one var builder:
//  - applyTheme(): injects a mode-scoped <style> (`:root:not(.dark)` / `:root.dark`)
//    so light edits never touch dark and vice-versa. Removes it when nothing is set.
//  - buildVarString(): the same CSS var text, for an inline preview container.
import { findPreset, type ThemeTokens } from "./themes";
import type { SiteSettings } from "../site.svelte";

export type ThemeMode = "light" | "dark";
export interface ThemeOverrides {
  light?: Partial<ThemeTokens>;
  dark?: Partial<ThemeTokens>;
}
export interface ThemeConfig {
  preset: string | null;
  brandColor: string | null;
  radius: string | null;
  overrides: ThemeOverrides | null;
}

const STYLE_ID = "podokit-theme";

/** Merge preset base with per-token overrides for one mode. */
export function effectiveTokens(config: ThemeConfig, mode: ThemeMode): Partial<ThemeTokens> {
  const preset = findPreset(config.preset);
  const base = (preset ? preset[mode] : null) ?? {};
  const over = config.overrides?.[mode] ?? {};
  return { ...base, ...over };
}

/** Build the CSS custom-property text for a mode. brandColor overrides primary;
 *  radius (a plain rem number) is appended with its unit. Only present tokens emit. */
export function buildVarString(tokens: Partial<ThemeTokens>, brandColor?: string | null, radius?: string | null): string {
  const lines: string[] = [];
  const set = (name: string, value?: string): void => {
    if (value) lines.push(`--${name}: ${value};`);
  };
  set("background", tokens.background);
  set("foreground", tokens.foreground);
  set("card", tokens.card);
  set("card-foreground", tokens.foreground);
  set("popover", tokens.card);
  set("popover-foreground", tokens.foreground);
  set("muted-foreground", tokens.mutedForeground);
  set("border", tokens.border);
  set("input", tokens.border);
  set("secondary", tokens.secondary);
  set("secondary-foreground", tokens.foreground);
  set("muted", tokens.secondary);
  set("accent", tokens.accent);
  set("accent-foreground", tokens.foreground);
  const primary = (brandColor ?? "").trim() || tokens.primary;
  set("primary", primary);
  set("ring", primary);
  set("primary-foreground", tokens.primaryForeground);
  // Sidebar tokens (admin dashboard) — derive the whole set so the sidebar
  // re-themes with the rest of the app, not just its accent.
  set("sidebar", tokens.card);
  set("sidebar-foreground", tokens.foreground);
  set("sidebar-primary", primary);
  set("sidebar-primary-foreground", tokens.primaryForeground);
  set("sidebar-accent", tokens.secondary);
  set("sidebar-accent-foreground", tokens.foreground);
  set("sidebar-border", tokens.border);
  set("sidebar-ring", primary);
  const r = (radius ?? "").trim();
  if (r) lines.push(`--radius: ${r}rem;`);
  return lines.join(" ");
}

/** True when the config would set no custom properties (falls back to app.css). */
export function isEmptyTheme(config: ThemeConfig): boolean {
  return (
    !buildVarString(effectiveTokens(config, "light"), config.brandColor, config.radius) &&
    !buildVarString(effectiveTokens(config, "dark"), config.brandColor, config.radius)
  );
}

/** Apply the theme globally via a mode-scoped stylesheet (client only). */
export function applyTheme(config: ThemeConfig): void {
  if (typeof document === "undefined") return;
  const lightVars = buildVarString(effectiveTokens(config, "light"), config.brandColor, config.radius);
  const darkVars = buildVarString(effectiveTokens(config, "dark"), config.brandColor, config.radius);
  const existing = document.getElementById(STYLE_ID);
  if (!lightVars && !darkVars) {
    existing?.remove();
    return;
  }
  const css =
    (lightVars ? `:root:not(.dark) { ${lightVars} }\n` : "") + (darkVars ? `:root.dark { ${darkVars} }` : "");
  const el = existing ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: STYLE_ID }));
  el.textContent = css;
}

/** Safely parse the stored themeOverrides JSON string into a typed object. */
export function parseOverrides(json: string | null | undefined): ThemeOverrides | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const pick = (v: unknown): Partial<ThemeTokens> | undefined => {
      if (!v || typeof v !== "object") return undefined;
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
      return out as Partial<ThemeTokens>;
    };
    const rec = parsed as Record<string, unknown>;
    return { light: pick(rec.light), dark: pick(rec.dark) };
  } catch {
    return null;
  }
}

/** Build a ThemeConfig from persisted site settings. */
export function themeConfigFromSettings(s: SiteSettings): ThemeConfig {
  return {
    preset: s.themePreset,
    brandColor: s.brandColor,
    radius: s.themeRadius,
    overrides: parseOverrides(s.themeOverrides),
  };
}
