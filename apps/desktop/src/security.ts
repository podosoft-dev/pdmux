export function normalizeFingerprint(value: string): string {
  const fingerprint = value.trim();
  // Electron exposes Chromium's sha256/base64 form; configuration uses hex.
  if (fingerprint.startsWith("sha256/")) {
    const encoded = fingerprint.slice(7);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return "";
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== encoded) return "";
    return bytes.toString("hex").toUpperCase();
  }
  const hex = fingerprint.replaceAll(":", "").toUpperCase();
  return /^[A-F0-9]{64}$/.test(hex) ? hex : "";
}

export function isAllowedAppNavigation(target: string, appUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(target: string, appUrl: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === "https:" && url.origin !== new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export function certificateMatches(
  requestHost: string,
  certificateFingerprint: string,
  remoteUrl: string,
  pins: readonly string[],
): boolean {
  try {
    const expectedHost = new URL(remoteUrl).hostname;
    if (requestHost !== expectedHost) return false;
    const actual = normalizeFingerprint(certificateFingerprint);
    return actual !== "" && pins.some((pin) => normalizeFingerprint(pin) === actual);
  } catch {
    return false;
  }
}
