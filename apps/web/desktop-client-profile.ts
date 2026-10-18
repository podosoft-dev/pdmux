/** Keep the shared REST client and base session transport, without server plugins.
 * Fail visibly on an SDK shape change instead of silently shipping admin code. */
export function desktopClientProfile(source: string): string {
  let removed = 0;
  const stripped = source.replace(/^import .* from "(?:better-auth\/client\/plugins|@better-auth\/(?:api-key|passkey)\/client)";\r?\n/gm, () => { removed += 1; return ""; });
  const start = stripped.indexOf("        plugins: [");
  const end = stripped.indexOf("        fetchOptions:", start);
  if (removed !== 3 || start < 0 || end < start) throw new Error("The API client changed; review the desktop authentication profile");
  return stripped.slice(0, start) + "        plugins: [],\n" + stripped.slice(end);
}
