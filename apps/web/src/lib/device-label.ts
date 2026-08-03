/**
 * A readable device name for a session's user agent.
 *
 * The sessions tables label this column "device", and a raw user agent does not
 * answer that question — truncated to fit a cell, every modern browser starts with
 * the same "Mozilla/5.0 (…" and the part that differs is off the end. This reduces
 * it to the two things someone scanning their own sessions is looking for: which
 * browser, on which machine.
 *
 * Returns null when the string is not a browser at all — a CLI, a script, or the
 * proxy's own default. The caller shows the raw value then, because for those the
 * exact string is the only useful information.
 */

/** Order matters: every one of these also contains an earlier engine's token. */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrome\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

/** iPadOS reports as Macintosh, so the iPad check has to come before macOS. */
const PLATFORMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows NT\b/, "Windows"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

function match(candidates: Array<[RegExp, string]>, value: string): string | null {
  for (const [pattern, label] of candidates) {
    if (pattern.test(value)) return label;
  }
  return null;
}

export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = match(BROWSERS, userAgent);
  const platform = match(PLATFORMS, userAgent);
  if (browser && platform) return `${browser} · ${platform}`;
  return browser ?? platform;
}
