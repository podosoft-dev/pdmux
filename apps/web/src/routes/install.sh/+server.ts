/**
 * `GET /install.sh` — the public one-line installer.
 *
 *   curl -fsSL https://pdmux.example.com/install.sh | sh -s -- --code pdmxe_…
 *
 * Public by necessity: the machine being onboarded has no session, no credential
 * and nothing installed. It is listed in `PUBLIC_PATHS` (guards.ts) so a backend
 * outage cannot turn it into a 503, and in the noindex list (search-indexing.ts)
 * because a shell script has no business in a search result.
 *
 * ⚠ THE ORIGIN IS DERIVED FROM REQUEST HEADERS AND BAKED INTO A FILE THAT GETS
 * PIPED INTO `sh`. Two things follow, and both are load-bearing:
 *
 *  1. The value is validated by `renderInstallScript`, which refuses anything that
 *     is not scheme + lower-case host + optional port. There is no escaping step to
 *     get wrong.
 *  2. The response is `Cache-Control: no-store` AND `Vary: X-Forwarded-Host, Host`.
 *     Miss either one and a Host-header attacker plus any cache in front of this app
 *     is remote code execution on the NEXT operator who runs the one-liner. The Vary
 *     is not decoration: it is the statement that this body depends on those headers.
 */

import type { RequestHandler } from "@sveltejs/kit";
import { loadAgentRelease } from "#lib/server/install-script/manifest.js";
import {
  isValidInstallScriptOrigin,
  renderInstallScript,
  renderUnavailableScript,
} from "#lib/server/install-script/render.js";

/** The body depends on request headers, so it can never be baked at build time. */
export const prerender = false;

const SCRIPT_HEADERS: Record<string, string> = {
  // What curl and browsers use to decide "this is a shell script, not a page".
  "content-type": "text/x-shellscript; charset=utf-8",
  // Every response is host-specific and version-specific. Nothing may keep it.
  "cache-control": "no-store",
  // The two inputs the body is derived from. Without this a shared cache is
  // entitled to serve one host's script to another host's operator.
  vary: "X-Forwarded-Host, Host",
  "x-content-type-options": "nosniff",
};

const BAD_ORIGIN_REASON =
  "This pdmux server could not work out its own public address from the request. " +
  "Check that the reverse proxy sets X-Forwarded-Host and X-Forwarded-Proto (or a plain Host header) " +
  "to the hostname operators actually use.";

const BAD_MANIFEST_REASON =
  "This pdmux server published a release manifest it will not vouch for. " +
  "Check the /agent tree it was built with; nothing is installed from a manifest that does not validate.";

/** First value of a possibly comma-joined proxy header, trimmed; null when absent or empty. */
function firstHeaderValue(request: Request, name: string): string | null {
  const raw = request.headers.get(name);
  if (raw === null) return null;
  const first = raw.split(",")[0]?.trim() ?? "";
  return first === "" ? null : first;
}

/**
 * The origin this installer should download from.
 *
 * ⚠ NOT `event.url.origin`. The adapter sees the internal listener unless external
 * origin metadata is configured, and a deployment that relied on it could serve
 * `http://localhost:3000` — a script that is syntactically perfect and installs
 * nothing, on every host, silently. The request's own headers are the only thing
 * that is true on a deployment nobody configured.
 *
 * Untrusted by construction: whatever comes back goes through the renderer's
 * allowlist before it can reach the script.
 */
/**
 * Hosts that are reached directly rather than through a TLS-terminating proxy.
 *
 * Loopback, link-local, and the three private IPv4 ranges — the addresses a
 * self-hosted pdmux is reached on from inside the same network.
 */
function isDirectlyReachedHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

/**
 * The origin this installer should download from.
 *
 * ⚠ NOT `event.url.origin`. The adapter sees the internal listener unless external
 * origin metadata is configured, and a deployment that relied on it could serve
 * `http://localhost:3000` — a script that is syntactically perfect and installs
 * nothing, on every host, silently. The request's own headers are the only thing
 * that is true on a deployment nobody configured.
 *
 * ⚠ AND THE SCHEME IS NOT ASSUMED TO BE `https`. Behind a proxy
 * `x-forwarded-proto` is authoritative. Reached DIRECTLY over plain http — a
 * self-hosted install, a private address, a laptop on the same network — there is no
 * such header, and `event.url.protocol` cannot identify the public scheme when an
 * internal listener and the public endpoint use different protocols. A plain-http
 * listener. Measured, not imagined: `curl … | sh` against a plain-http pdmux died on
 * `SSL routines::wrong version number` while downloading the binary — *after* the
 * script itself had been fetched over http without complaint, which reads as "the
 * installer is broken" rather than "the scheme was guessed".
 *
 * So the fallback is decided by the host: a loopback or private address is reached
 * directly and means http; a public name is behind something that terminates TLS.
 * Guessing upward is not a security improvement — nothing downgrades, it just fails.
 * An operator who needs the other answer passes `--server`.
 *
 * Untrusted by construction: whatever comes back goes through the renderer's
 * allowlist before it can reach the script.
 */
function resolveRequestOrigin(request: Request): string | null {
  const host = firstHeaderValue(request, "x-forwarded-host") ?? firstHeaderValue(request, "host");
  if (host === null) return null;
  const lower = host.toLowerCase();
  const hostname = lower.replace(/:\d+$/, "");
  const forwarded = firstHeaderValue(request, "x-forwarded-proto");
  const proto = (forwarded ?? (isDirectlyReachedHost(hostname) ? "http" : "https")).toLowerCase();
  return `${proto}://${lower}`;
}

export const GET: RequestHandler = (event) => {
  return new Response(renderBody(resolveRequestOrigin(event.request)), { status: 200, headers: SCRIPT_HEADERS });
};

/**
 * Always a script, never an error status — see `renderUnavailableScript` for why a
 * 503 is invisible at the far end of `curl -fsSL | sh`.
 */
function renderBody(origin: string | null): string {
  // Checked here as well as inside the renderer, so a forged Host is answered with
  // the reason that actually applies — and so an attacker's request never reaches
  // the filesystem. `renderInstallScript` stays the single point of ENFORCEMENT.
  if (origin === null || !isValidInstallScriptOrigin(origin)) return renderUnavailableScript(BAD_ORIGIN_REASON);

  const { release, reason } = loadAgentRelease();
  if (release === null) return renderUnavailableScript(reason);

  try {
    return renderInstallScript({ origin, version: release.version, artifacts: release.artifacts });
  } catch {
    // A refusal, not a crash. The rejected value is deliberately NOT echoed into the
    // output: it is attacker-controlled in exactly the case that matters.
    return renderUnavailableScript(BAD_MANIFEST_REASON);
  }
}
