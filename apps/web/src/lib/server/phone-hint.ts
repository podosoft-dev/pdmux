/**
 * A first-paint guess at whether the request came from a phone.
 *
 * The narrow-screen shell renders one pane instead of the saved split, and that decision
 * is a media query — which has no answer on the server, so it defaults to "desktop" and
 * a phone paints the whole 3x3 grid before collapsing to a single pane. The flash is the
 * bug; the split it briefly shows was never this device's layout.
 *
 * `sec-ch-ua-mobile` is the browser telling us directly (Chromium sends it on every
 * request); the user-agent test is the fallback for browsers that do not, iOS Safari
 * being the one that matters here. It is a HINT and nothing downstream may treat it as
 * a measurement: the moment the client hydrates, the real media query takes over and
 * wins. A wrong guess costs exactly what today costs unconditionally — one reflow.
 *
 * ⚠ IT LIVES IN `$lib`, NOT IN THE LAYOUT, AND THAT IS NOT TIDINESS. SvelteKit validates
 * the export list of every route module and accepts only its own vocabulary (`load`,
 * `prerender`, `ssr`, `csr`, `trailingSlash`, `config`, `entries`). A helper exported
 * from `+layout.server.ts` fails that check at request time — `Invalid export
 * 'looksLikePhone'` — and the whole route answers 500. It was exported only so a unit
 * test could import it, and it took `/hosts` down with it.
 */
export function looksLikePhone(request: Request): boolean {
  const hint = request.headers.get("sec-ch-ua-mobile");
  if (hint) return hint === "?1";
  return /Android|iPhone|iPod|Mobile|Windows Phone/i.test(request.headers.get("user-agent") ?? "");
}
