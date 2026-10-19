interface LocalFont { family: string }
type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFont[]> };

export function canReadLocalFonts(): boolean {
  return typeof window !== "undefined" && typeof (window as FontWindow).queryLocalFonts === "function";
}

/** Font Access supplies OS families; widths exclude proportional faces. No font bytes are read. */
export async function installedTerminalFonts(): Promise<string[]> {
  const query = (window as FontWindow).queryLocalFonts;
  if (!query) throw new Error("Local font access unavailable");
  const fonts = await query.call(window);
  // Chromium can return an empty inventory when access is denied.
  if (fonts.length === 0) throw new Error("No installed fonts available");
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Font measurement unavailable");
  return monospaceFamilies(fonts.map(font => font.family), (family, sample) => {
    // A proportional fallback rejects families without these Latin glyphs,
    // instead of mistaking the fallback's fixed widths for the installed face.
    context.font = `32px ${JSON.stringify(family)}, serif`;
    return context.measureText(sample).width;
  });
}

export function monospaceFamilies(families: readonly string[], measure: (family: string, sample: string) => number): string[] {
  return [...new Set(families)].filter(family => {
    if (!family.trim() || family.length > 120 || /[\x00-\x1f\x7f]/.test(family)) return false;
    const widths = ["iiiiiiii", "WWWWWWWW", "00000000", "mmmmmmmm", "........"].map(sample => measure(family, sample));
    return widths.every(width => Number.isFinite(width) && width > 0 && Math.abs(width - widths[0]!) < 0.1);
  }).sort((a, b) => a.localeCompare(b));
}
