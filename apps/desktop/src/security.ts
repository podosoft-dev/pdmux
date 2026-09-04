export function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").trim().toUpperCase();
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
    return pins.some((pin) => normalizeFingerprint(pin) === actual);
  } catch {
    return false;
  }
}
