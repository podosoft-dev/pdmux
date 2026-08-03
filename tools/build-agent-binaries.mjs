#!/usr/bin/env node
/**
 * Cross-compiles the Go host agent and lays the result out the way the public
 * installer will ask for it.
 *
 * HOW TO RUN IT
 *
 *   npm run build:agent          # from the repo root, needs a Go toolchain
 *
 * ⚠ IT IS DELIBERATELY NOT PART OF `npm run build`. The root build is
 * `npm run build --workspaces --if-present`, which runs on every CI machine, and CI
 * has no Go toolchain — wiring this in would turn "no Go" into a red build for a
 * change that never touched the agent. It is opt-in: a release job, the Docker
 * builder stage (`apps/web/Dockerfile`), or a human runs it on purpose.
 *
 * WHAT IT PRODUCES, under `apps/web/static/agent/<version>/`:
 *
 *   pdmux-agent-<os>-<arch>   one static binary per supported target
 *   SHA256SUMS                `sha256sum -c` format, so a human can verify by hand
 *   manifest.json             what the server reads to answer "what is the newest
 *                             build for this host's platform, and what should it hash to"
 *
 * `static/` is what Vite copies into `build/client/`, so these files are served at
 * `/agent/<version>/…` by the same origin the agent already talks to. No object
 * store, no second hostname, no credentials — which is the entire reason the
 * installer can be a one-liner.
 *
 * ON DETERMINISM: two runs over unchanged source must produce byte-identical
 * binaries, because the update path pins a sha256 and a "new" hash for the same
 * version would send every host into a pointless re-download. That is why
 * `-trimpath` (no absolute build paths) and `-buildvcs=false` (no commit id, and
 * more importantly no repo-wide dirty flag — otherwise editing a README would
 * change the agent's hash) are not optional flags here.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const AGENT_DIR = join(ROOT, "agent");
const VERSION_FILE = join(AGENT_DIR, "internal/cli/version.go");
const OUT_ROOT = join(ROOT, "apps/web/static/agent");

/** The import path of the package holding `AgentVersion`, for the linker's `-X`. */
const VERSION_SYMBOL = "github.com/podosoft-dev/pdmux/agent/internal/cli.AgentVersion";

/**
 * The platforms a published release covers. Every one of them builds with
 * `CGO_ENABLED=0`, so each artifact is a single file with no runtime to install —
 * the precondition that lets the installer be `curl … | sh`.
 */
const TARGETS = [
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
];

/**
 * The official SemVer grammar (semver.org's own expression, named groups dropped).
 *
 * WHY VALIDATE AT ALL: this string becomes a URL path segment and the manifest's
 * `version`, which the server compares with `compareSemver`. A value that does not
 * parse makes every host read as `unknown` forever — and the place to notice that is
 * here, at the build, not on a dashboard three days later.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * The version comes out of the Go source, never out of a second file.
 *
 * `agent/internal/cli/version.go` is where a developer bumps the agent, where
 * `--version` reads from, and what an unstamped `go build` reports. Adding a
 * package.json field or a release argument beside it would create two truths that
 * drift silently — and a manifest that disagrees with its own binary is exactly the
 * "permanently outdated host" failure this pipeline is built to avoid.
 */
function readAgentVersion() {
  const source = readFileSync(VERSION_FILE, "utf8");
  // `var` today; `const` is matched too so a well-meaning revert fails loudly at the
  // stamping check rather than silently shipping an unstamped binary.
  const match = /^\s*(?:var|const)\s+AgentVersion\s*=\s*"([^"]+)"/m.exec(source);
  if (!match) {
    throw new Error(`No 'AgentVersion = "…"' declaration in ${rel(VERSION_FILE)}`);
  }
  const version = match[1];
  if (!SEMVER.test(version)) {
    throw new Error(
      `AgentVersion ${JSON.stringify(version)} in ${rel(VERSION_FILE)} is not SemVer; ` +
        `it would become a URL path and a version the server cannot compare.`,
    );
  }
  return version;
}

function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function goVersion() {
  try {
    return execFileSync("go", ["version"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "No `go` on PATH. This script cross-compiles the agent, so it needs a Go toolchain " +
        "(that is also why it is not part of `npm run build`).",
    );
  }
}

function buildTarget({ os, arch }, version, outDir) {
  const name = `pdmux-agent-${os}-${arch}`;
  execFileSync(
    "go",
    [
      "build",
      // Absolute paths of the build machine would otherwise land in the binary,
      // making one developer's output differ from another's for identical source.
      "-trimpath",
      // No VCS stamping: it embeds the commit AND a repo-wide "dirty" flag, so an
      // unrelated edit anywhere in the tree would change the agent's sha256.
      "-buildvcs=false",
      "-ldflags",
      `-s -w -X ${VERSION_SYMBOL}=${version}`,
      "-o",
      join(outDir, name),
      "./cmd/pdmux-agent",
    ],
    {
      cwd: AGENT_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        GOOS: os,
        GOARCH: arch,
        // A cgo build links against the build machine's libc and stops being the
        // "no preconditions on the target" artifact the installer promises.
        CGO_ENABLED: "0",
      },
    },
  );
  return name;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const version = readAgentVersion();
  const outDir = join(OUT_ROOT, version);

  console.log(`pdmux-agent ${version}`);
  console.log(`  toolchain  ${goVersion()}`);
  console.log(`  output     ${rel(outDir)}`);

  // Rebuilding a version replaces it wholesale. A stale artifact left from a
  // renamed target would still be listed by SHA256SUMS' directory neighbours and
  // still be downloadable, while belonging to no manifest entry.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const artifacts = [];
  for (const target of TARGETS) {
    const name = buildTarget(target, version, outDir);
    const path = join(outDir, name);
    const bytes = statSync(path).size;
    const digest = sha256(path);
    artifacts.push({
      os: target.os,
      arch: target.arch,
      // The URL the installer requests, NOT a filesystem path: `static/` is served
      // from the site root, so `static/agent/<v>/x` is reachable at `/agent/<v>/x`.
      path: `/agent/${version}/${name}`,
      sha256: digest,
      bytes,
    });
    console.log(`  built      ${name}  ${(bytes / 1024 / 1024).toFixed(1)} MiB  ${digest.slice(0, 12)}…`);
  }

  // Two spaces between hash and name, bare filenames: exactly what `sha256sum -c
  // SHA256SUMS` expects when run inside this directory. An operator who does not
  // trust the manifest can check the download by hand with a tool they already have.
  writeFileSync(
    join(outDir, "SHA256SUMS"),
    artifacts.map((a) => `${a.sha256}  ${a.path.split("/").pop()}`).join("\n") + "\n",
  );

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        // THE AGENT'S OWN SemVer — not the repo's. A web-only release must not
        // paint every host amber and then offer it a byte-identical binary.
        version,
        // The only field that moves between two otherwise identical runs. It is
        // metadata for a human reading the directory; nothing compares it, and it is
        // deliberately outside the hashed artifacts.
        builtAt: new Date().toISOString(),
        artifacts,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`  wrote      SHA256SUMS, manifest.json`);
}

main();
