/**
 * Renders the public one-line installer, `GET /install.sh`.
 *
 * ⚠ THE OUTPUT OF THIS MODULE IS PIPED INTO `sh` ON SOMEBODY ELSE'S MACHINE.
 * Every value it interpolates comes from either a request header (the origin) or a
 * build artifact (the manifest), and both are checked against a strict allowlist
 * here rather than escaped. Escaping is a promise about a quoting context;
 * an allowlist is a promise about the value, and only the second one survives a
 * later edit that moves the interpolation from inside single quotes to inside a
 * command substitution.
 *
 * The function is pure — it takes an origin, a version and the artifact list, and
 * returns a string. The header-reading, the manifest fetch and the response headers
 * live in the route (src/routes/install.sh/+server.ts), so everything dangerous
 * about this file can be asserted without a server.
 */

// The script is a real .sh file, not a template literal, so `shellcheck -s sh` and
// `sh -n` can be run against it directly and an editor treats it as shell.
import template from "./install.sh?raw";

export type InstallScriptArtifact = {
  /** GOOS, e.g. `linux`. */
  os: string;
  /** GOARCH, e.g. `amd64`. */
  arch: string;
  /** URL path on this origin, e.g. `/agent/0.1.0/pdmux-agent-linux-amd64`. */
  path: string;
  /** Lowercase hex sha256 of the artifact. */
  sha256: string;
};

export type RenderInstallScriptInput = {
  /** Public origin the installer downloads from, e.g. `https://pdmux.example.com`. */
  origin: string;
  /** Agent SemVer this origin publishes. */
  version: string;
  artifacts: readonly InstallScriptArtifact[];
};

/**
 * Refusal to render. The route turns it into a script that says so and exits 1 —
 * never into a script that runs anyway with a value we could not vouch for.
 */
export class InstallScriptRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallScriptRenderError";
  }
}

/**
 * Scheme + lower-cased host + optional port, and nothing else.
 *
 * No userinfo, no path, no query, no fragment, no uppercase, no IPv6 literal in
 * brackets. Each exclusion is a character class that would otherwise reach a shell:
 * `@` hides the real host from a human reading the script, `/` and `?` let an
 * attacker choose the download path, and `[`/`]` are the only host syntax that
 * needs bracket characters at all. A pdmux deployment is reached by a DNS name (or
 * an IPv4 literal, which this does allow); an operator on a bare IPv6 address gets
 * a refusal that names the problem rather than a script built from an address we
 * did not fully parse.
 */
const ORIGIN_PATTERN =
  /^https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/** semver.org's own expression, named groups dropped — the same one the build script uses. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const TARGET_PATTERN = /^[a-z0-9]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Everything after `/agent/<version>/`. Deliberately excludes `%`, so nothing here can be percent-encoding something else. */
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const ORIGIN_PLACEHOLDER = "@@ORIGIN@@";
const VERSION_PLACEHOLDER = "@@VERSION@@";
const ARTIFACTS_BEGIN = "# pdmux:artifacts:begin";
const ARTIFACTS_END = "# pdmux:artifacts:end";

/** True when `origin` is safe to bake into a script the world pipes into `sh`. */
export function isValidInstallScriptOrigin(origin: string): boolean {
  if (!ORIGIN_PATTERN.test(origin)) return false;
  const port = /:(\d+)$/.exec(origin)?.[1];
  // The pattern caps the port at five digits, which still admits 99999. A port is
  // a 16-bit number or it is not a port.
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

/**
 * Asserts that a value can sit inside a single-quoted shell word without changing
 * its meaning. The allowlists above already guarantee it; this is the belt to their
 * braces, and the thing that fails loudly if one of them is ever loosened.
 */
function assertSingleQuotable(what: string, value: string): string {
  if (/['\\\n\r]/.test(value)) {
    throw new InstallScriptRenderError(`${what} contains a character that cannot be quoted in a shell script`);
  }
  return value;
}

function replaceOnce(text: string, placeholder: string, value: string): string {
  const first = text.indexOf(placeholder);
  if (first === -1 || text.indexOf(placeholder, first + placeholder.length) !== -1) {
    // A template edit that dropped or duplicated a placeholder would otherwise
    // ship a script with a literal `@@ORIGIN@@` in it, or with only the first of
    // two occurrences filled in.
    throw new InstallScriptRenderError(`install.sh template must contain ${placeholder} exactly once`);
  }
  // A replacer function, not a string: `$&`, `$'` and friends are special in a
  // string replacement, and `$'` is exactly the sequence an attacker would aim for.
  return text.replace(placeholder, () => value);
}

/** The generated body of the `# pdmux:artifacts:` fence — one `case` arm per target. */
function renderArtifactCase(version: string, artifacts: readonly InstallScriptArtifact[]): string {
  const seen = new Set<string>();
  const arms: string[] = [];

  for (const artifact of artifacts) {
    if (!TARGET_PATTERN.test(artifact.os) || !TARGET_PATTERN.test(artifact.arch)) {
      throw new InstallScriptRenderError(`unusable os/arch in the release manifest: ${artifact.os}/${artifact.arch}`);
    }
    const key = `${artifact.os}-${artifact.arch}`;
    if (seen.has(key)) {
      // Two arms for one target means the second is dead code and the operator
      // gets whichever checksum happened to be written first.
      throw new InstallScriptRenderError(`the release manifest lists ${key} twice`);
    }
    seen.add(key);

    if (!SHA256_PATTERN.test(artifact.sha256)) {
      throw new InstallScriptRenderError(`${key} has no lowercase hex sha256 in the release manifest`);
    }
    // The path must belong to THIS version's directory. It is what ties the baked
    // checksum to the bytes the script will ask for, and it keeps the download
    // inside the one prefix that is deliberately public (see guards.ts).
    const prefix = `/agent/${version}/`;
    if (!artifact.path.startsWith(prefix) || !ARTIFACT_NAME_PATTERN.test(artifact.path.slice(prefix.length))) {
      throw new InstallScriptRenderError(`${key} does not publish under ${prefix} in the release manifest`);
    }

    arms.push(
      `    ${key})\n` +
        `      artifact_path='${assertSingleQuotable("artifact path", artifact.path)}'\n` +
        `      artifact_sha256='${artifact.sha256}'\n` +
        `      ;;`,
    );
  }

  if (arms.length === 0) {
    throw new InstallScriptRenderError("the release manifest publishes no artifacts");
  }

  return [
    "resolve_artifact() {",
    '  case "$1" in',
    ...arms,
    "    *)",
    "      return 1",
    "      ;;",
    "  esac",
    "}",
  ].join("\n");
}

/**
 * Renders the installer for one origin and one published agent release.
 *
 * Throws `InstallScriptRenderError` rather than returning a partial script: there
 * is no degraded mode in which it is acceptable to hand somebody a shell script
 * built from a value this module could not vouch for.
 */
export function renderInstallScript(input: RenderInstallScriptInput): string {
  const { origin, version, artifacts } = input;

  if (!isValidInstallScriptOrigin(origin)) {
    throw new InstallScriptRenderError(`refusing to render an installer for the origin ${JSON.stringify(origin)}`);
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new InstallScriptRenderError(`refusing to render an installer for the version ${JSON.stringify(version)}`);
  }

  let script = template;
  script = replaceOnce(script, ORIGIN_PLACEHOLDER, assertSingleQuotable("origin", origin));
  script = replaceOnce(script, VERSION_PLACEHOLDER, assertSingleQuotable("version", version));

  const begin = script.indexOf(ARTIFACTS_BEGIN);
  const end = script.indexOf(ARTIFACTS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new InstallScriptRenderError("install.sh template is missing its pdmux:artifacts fence");
  }
  script =
    script.slice(0, begin + ARTIFACTS_BEGIN.length) +
    "\n" +
    renderArtifactCase(version, artifacts) +
    "\n" +
    script.slice(end);

  if (script.includes("@@")) {
    throw new InstallScriptRenderError("install.sh template still has an unfilled placeholder after rendering");
  }
  return script;
}

/** Anything outside this is dropped from a reason string before it is quoted. */
const REASON_SAFE = /[^A-Za-z0-9 .,:;()[\]/@_-]/g;

/**
 * The script served when there is nothing to install — no release built into this
 * deployment, an unreadable manifest, or an origin we refuse to vouch for.
 *
 * ⚠ IT IS A 200, AND THAT IS THE POINT. The caller is `curl -fsSL … | sh`: `-f`
 * makes curl exit silently on a 4xx/5xx, `-s` hides its error, and the operator
 * watches an empty prompt with no idea whether anything happened. A script that
 * prints the reason and exits non-zero is the only shape of answer that survives
 * that pipeline.
 */
export function renderUnavailableScript(reason: string): string {
  const safe = reason.replace(REASON_SAFE, " ").trim().slice(0, 300) || "the reason was not recorded";
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "# pdmux install.sh — this server has nothing to install right now.",
    "#",
    "# Served as a 200 on purpose: `curl -fsSL | sh` prints NOTHING for an error",
    "# status, so a 503 here would look to the operator like a command that did",
    "# nothing at all. Read the message, fix the server, run the same line again.",
    `printf 'install.sh: %s\\n' '${safe}' >&2`,
    "printf 'install.sh: %s\\n' 'Nothing was downloaded and nothing was installed.' >&2",
    "exit 1",
    "",
  ].join("\n");
}
