// Built-in theme presets for the admin Appearance settings. A preset is a full
// neutral+surface+accent base for light and dark; the admin can layer a
// brand-color accent, a radius, and per-token overrides on top (see
// apply-theme.ts). Two families ship:
//  - shadcn bases/accents (hex from the official shadcn theme registry), and
//  - popular code-editor palettes (Dracula, Nord, Solarized, Gruvbox,
//    Catppuccin, Tokyo Night, Rosé Pine, One Dark, Everforest, Monokai, GitHub)
//    that vary the background/foreground, not just the accent.
// `default` = no override, so the app's own app.css tokens show through.

/** The editable subset of theme tokens; apply-theme expands these to CSS vars. */
export interface ThemeTokens {
  background: string;
  card: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  secondary: string;
  accent: string;
  primary: string;
  primaryForeground: string;
}

export interface ThemePreset {
  key: string;
  label: string;
  /** null = leave this mode on the app.css defaults (the `default` preset). */
  light: ThemeTokens | null;
  dark: ThemeTokens | null;
}

export const themePresets: ThemePreset[] = [
  { key: "default", label: "Default", light: null, dark: null },

  // --- shadcn neutral bases (accent = neutral, background stays white/near-black) ---
  { key: "zinc", label: "Zinc", light: { background: "#ffffff", card: "#ffffff", foreground: "#09090b", mutedForeground: "#71717a", border: "#e4e4e7", secondary: "#f4f4f5", accent: "#f4f4f5", primary: "#18181b", primaryForeground: "#fafafa" }, dark: { background: "#09090b", card: "#09090b", foreground: "#fafafa", mutedForeground: "#a1a1aa", border: "#27272a", secondary: "#27272a", accent: "#27272a", primary: "#fafafa", primaryForeground: "#18181b" } },
  { key: "slate", label: "Slate", light: { background: "#ffffff", card: "#ffffff", foreground: "#020817", mutedForeground: "#64748b", border: "#e2e8f0", secondary: "#f1f5f9", accent: "#f1f5f9", primary: "#0f172a", primaryForeground: "#f8fafc" }, dark: { background: "#020817", card: "#020817", foreground: "#f8fafc", mutedForeground: "#94a3b8", border: "#1e293b", secondary: "#1e293b", accent: "#1e293b", primary: "#f8fafc", primaryForeground: "#0f172a" } },
  { key: "stone", label: "Stone", light: { background: "#ffffff", card: "#ffffff", foreground: "#0c0a09", mutedForeground: "#78716c", border: "#e7e5e4", secondary: "#f5f5f4", accent: "#f5f5f4", primary: "#1c1917", primaryForeground: "#fafaf9" }, dark: { background: "#0c0a09", card: "#0c0a09", foreground: "#fafaf9", mutedForeground: "#a8a29e", border: "#292524", secondary: "#292524", accent: "#292524", primary: "#fafaf9", primaryForeground: "#1c1917" } },
  { key: "gray", label: "Gray", light: { background: "#ffffff", card: "#ffffff", foreground: "#030712", mutedForeground: "#6b7280", border: "#e5e7eb", secondary: "#f3f4f6", accent: "#f3f4f6", primary: "#111827", primaryForeground: "#f9fafb" }, dark: { background: "#030712", card: "#030712", foreground: "#f9fafb", mutedForeground: "#9ca3af", border: "#1f2937", secondary: "#1f2937", accent: "#1f2937", primary: "#f9fafb", primaryForeground: "#111827" } },
  { key: "neutral", label: "Neutral", light: { background: "#ffffff", card: "#ffffff", foreground: "#0a0a0a", mutedForeground: "#737373", border: "#e5e5e5", secondary: "#f5f5f5", accent: "#f5f5f5", primary: "#171717", primaryForeground: "#fafafa" }, dark: { background: "#0a0a0a", card: "#0a0a0a", foreground: "#fafafa", mutedForeground: "#a3a3a3", border: "#262626", secondary: "#262626", accent: "#262626", primary: "#fafafa", primaryForeground: "#171717" } },

  // --- shadcn accent bases (colored primary on a neutral background) ---
  { key: "blue", label: "Blue", light: { background: "#ffffff", card: "#ffffff", foreground: "#020817", mutedForeground: "#64748b", border: "#e2e8f0", secondary: "#f1f5f9", accent: "#f1f5f9", primary: "#2563eb", primaryForeground: "#f8fafc" }, dark: { background: "#020817", card: "#020817", foreground: "#f8fafc", mutedForeground: "#94a3b8", border: "#1e293b", secondary: "#1e293b", accent: "#1e293b", primary: "#3b82f6", primaryForeground: "#0f172a" } },
  { key: "green", label: "Green", light: { background: "#ffffff", card: "#ffffff", foreground: "#09090b", mutedForeground: "#71717a", border: "#e4e4e7", secondary: "#f4f4f5", accent: "#f4f4f5", primary: "#16a34a", primaryForeground: "#f0fdf4" }, dark: { background: "#0c0a09", card: "#1c1917", foreground: "#f2f2f2", mutedForeground: "#a1a1aa", border: "#27272a", secondary: "#27272a", accent: "#292524", primary: "#22c55e", primaryForeground: "#052e16" } },
  { key: "violet", label: "Violet", light: { background: "#ffffff", card: "#ffffff", foreground: "#030712", mutedForeground: "#6b7280", border: "#e5e7eb", secondary: "#f3f4f6", accent: "#f3f4f6", primary: "#7c3aed", primaryForeground: "#f9fafb" }, dark: { background: "#030712", card: "#030712", foreground: "#f9fafb", mutedForeground: "#9ca3af", border: "#1f2937", secondary: "#1f2937", accent: "#1f2937", primary: "#8b5cf6", primaryForeground: "#f9fafb" } },
  { key: "rose", label: "Rose", light: { background: "#ffffff", card: "#ffffff", foreground: "#09090b", mutedForeground: "#71717a", border: "#e4e4e7", secondary: "#f4f4f5", accent: "#f4f4f5", primary: "#e11d48", primaryForeground: "#fff1f2" }, dark: { background: "#0c0a09", card: "#1c1917", foreground: "#f2f2f2", mutedForeground: "#a1a1aa", border: "#27272a", secondary: "#27272a", accent: "#292524", primary: "#e11d48", primaryForeground: "#fff1f2" } },

  // --- popular code-editor palettes (distinct background/foreground, not just accent) ---
  { key: "dracula", label: "Dracula", light: { background: "#f8f8f2", card: "#ffffff", foreground: "#282a36", mutedForeground: "#6272a4", border: "#e3e0f0", secondary: "#eeecf7", accent: "#e8e5f5", primary: "#7c5cbf", primaryForeground: "#ffffff" }, dark: { background: "#282a36", card: "#343746", foreground: "#f8f8f2", mutedForeground: "#6272a4", border: "#44475a", secondary: "#44475a", accent: "#4d5066", primary: "#bd93f9", primaryForeground: "#282a36" } },
  { key: "nord", label: "Nord", light: { background: "#eceff4", card: "#ffffff", foreground: "#2e3440", mutedForeground: "#4c566a", border: "#d8dee9", secondary: "#e5e9f0", accent: "#dfe4ee", primary: "#5e81ac", primaryForeground: "#eceff4" }, dark: { background: "#2e3440", card: "#3b4252", foreground: "#eceff4", mutedForeground: "#7b88a1", border: "#434c5e", secondary: "#3b4252", accent: "#434c5e", primary: "#88c0d0", primaryForeground: "#2e3440" } },
  { key: "solarized", label: "Solarized", light: { background: "#fdf6e3", card: "#fbf0d6", foreground: "#586e75", mutedForeground: "#93a1a1", border: "#eee8d5", secondary: "#eee8d5", accent: "#e7e0c8", primary: "#268bd2", primaryForeground: "#fdf6e3" }, dark: { background: "#002b36", card: "#073642", foreground: "#93a1a1", mutedForeground: "#657b83", border: "#0e4b59", secondary: "#073642", accent: "#0e4b59", primary: "#268bd2", primaryForeground: "#fdf6e3" } },
  { key: "gruvbox", label: "Gruvbox", light: { background: "#fbf1c7", card: "#f9f5d7", foreground: "#3c3836", mutedForeground: "#7c6f64", border: "#ebdbb2", secondary: "#ebdbb2", accent: "#e3d5aa", primary: "#b57614", primaryForeground: "#fbf1c7" }, dark: { background: "#282828", card: "#32302f", foreground: "#ebdbb2", mutedForeground: "#a89984", border: "#504945", secondary: "#3c3836", accent: "#504945", primary: "#fabd2f", primaryForeground: "#282828" } },
  { key: "catppuccin", label: "Catppuccin", light: { background: "#eff1f5", card: "#ffffff", foreground: "#4c4f69", mutedForeground: "#6c6f85", border: "#dce0e8", secondary: "#e6e9ef", accent: "#ccd0da", primary: "#8839ef", primaryForeground: "#eff1f5" }, dark: { background: "#1e1e2e", card: "#313244", foreground: "#cdd6f4", mutedForeground: "#a6adc8", border: "#45475a", secondary: "#313244", accent: "#45475a", primary: "#cba6f7", primaryForeground: "#1e1e2e" } },
  { key: "tokyo-night", label: "Tokyo Night", light: { background: "#e1e2e7", card: "#ffffff", foreground: "#3760bf", mutedForeground: "#848cb5", border: "#c4c8da", secondary: "#d0d5e3", accent: "#c8cde0", primary: "#2e7de9", primaryForeground: "#ffffff" }, dark: { background: "#1a1b26", card: "#24283b", foreground: "#c0caf5", mutedForeground: "#565f89", border: "#292e42", secondary: "#24283b", accent: "#2f344d", primary: "#7aa2f7", primaryForeground: "#1a1b26" } },
  { key: "rose-pine", label: "Rosé Pine", light: { background: "#faf4ed", card: "#fffaf3", foreground: "#575279", mutedForeground: "#797593", border: "#f2e9e1", secondary: "#fffaf3", accent: "#f2e9e1", primary: "#907aa9", primaryForeground: "#faf4ed" }, dark: { background: "#191724", card: "#1f1d2e", foreground: "#e0def4", mutedForeground: "#908caa", border: "#26233a", secondary: "#1f1d2e", accent: "#26233a", primary: "#c4a7e7", primaryForeground: "#191724" } },
  { key: "one-dark", label: "One Dark", light: { background: "#fafafa", card: "#ffffff", foreground: "#383a42", mutedForeground: "#a0a1a7", border: "#e5e5e6", secondary: "#f0f0f0", accent: "#eaeaeb", primary: "#4078f2", primaryForeground: "#ffffff" }, dark: { background: "#282c34", card: "#21252b", foreground: "#abb2bf", mutedForeground: "#5c6370", border: "#3b4048", secondary: "#2c313a", accent: "#3b4048", primary: "#61afef", primaryForeground: "#282c34" } },
  { key: "everforest", label: "Everforest", light: { background: "#fdf6e3", card: "#f4f0d9", foreground: "#5c6a72", mutedForeground: "#939f91", border: "#eae4cf", secondary: "#f4f0d9", accent: "#eae4cf", primary: "#8da101", primaryForeground: "#fdf6e3" }, dark: { background: "#2d353b", card: "#343f44", foreground: "#d3c6aa", mutedForeground: "#859289", border: "#3d484d", secondary: "#343f44", accent: "#3d484d", primary: "#a7c080", primaryForeground: "#2d353b" } },
  { key: "monokai", label: "Monokai", light: { background: "#fafafa", card: "#ffffff", foreground: "#272822", mutedForeground: "#75715e", border: "#e6e6e6", secondary: "#f0f0f0", accent: "#eaeaea", primary: "#e6187f", primaryForeground: "#ffffff" }, dark: { background: "#272822", card: "#2f302a", foreground: "#f8f8f2", mutedForeground: "#75715e", border: "#414339", secondary: "#3e3d32", accent: "#414339", primary: "#f92672", primaryForeground: "#ffffff" } },
  { key: "github", label: "GitHub", light: { background: "#ffffff", card: "#ffffff", foreground: "#1f2328", mutedForeground: "#656d76", border: "#d0d7de", secondary: "#f6f8fa", accent: "#eaeef2", primary: "#1f66d0", primaryForeground: "#ffffff" }, dark: { background: "#0d1117", card: "#161b22", foreground: "#e6edf3", mutedForeground: "#8b949e", border: "#30363d", secondary: "#161b22", accent: "#21262d", primary: "#2f81f7", primaryForeground: "#ffffff" } },
];

// Keep the first choice focused without removing any of the long-lived preset
// keys. The Appearance screen shows these up front and puts the rest behind a
// disclosure so a new user is not greeted by a 21-item wall of options.
export const FEATURED_THEME_PRESET_KEYS = ["default", "neutral", "slate", "blue", "green", "violet"] as const;

export const THEME_TOKEN_KEYS: readonly (keyof ThemeTokens)[] = [
  "background",
  "card",
  "foreground",
  "mutedForeground",
  "border",
  "secondary",
  "accent",
  "primary",
  "primaryForeground",
];

export function findPreset(key: string | null | undefined): ThemePreset | undefined {
  return themePresets.find((p) => p.key === key);
}
