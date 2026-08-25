import { ProductLogger } from "../logging/product-logger";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVersionStrings, parseSemver } from "@pdmux/protocol";

/**
 * Which agent builds this deployment publishes, and what they hash to.
 *
 * ⚠ WHERE THE DATA COMES FROM, AND WHY IT IS A DIRECTORY THIS SERVICE IS *TOLD*
 * ABOUT.
 *
 * `tools/build-agent-binaries.mjs` writes `<root>/<version>/manifest.json` plus
 * the binaries beside it, and the web tier serves that tree at `/agent/<v>/…`.
 * The API needs the same facts (which versions exist, which platforms each one
 * covers, what the bytes hash to) to fill in an `update` frame and to say whether
 * a host is behind.
 *
 * Three mechanisms were possible, and the choice matters:
 *
 *  1. REACH INTO THE WEB WORKSPACE (`../web/build/client/agent`). Rejected as the
 *     contract: it hard-codes another container's internal layout, and in the
 *     split-image deployment that directory does not exist in this image at all.
 *  2. FETCH IT FROM THE WEB OVER HTTP. Rejected: there is no release index to
 *     fetch (the builder writes one manifest per version, so `/agent/manifest.json`
 *     404s — the web's own `install-script/manifest.ts` says so), it would need a
 *     new public endpoint plus an origin the API can only guess at, and it turns a
 *     dashboard render into a cross-service round trip that fails in a new way.
 *  3. READ A RELEASE ROOT THIS SERVICE IS CONFIGURED WITH — chosen.
 *     `AGENT_RELEASE_DIR` names the directory holding `<version>/manifest.json`.
 *     The shape it reads is the *release tool's* output format, not a web-app
 *     detail, so a deployment that publishes releases some other way only has to
 *     lay them out that way.
 *
 * TRADE-OFF, STATED PLAINLY: in a split-image deployment somebody has to mount
 * the published release tree into this container (or point the variable at it),
 * and nothing here checks that the web actually serves what this reads — the two
 * can disagree, in which case the agent's download 404s and it reports
 * `DOWNLOAD_FAILED`. What is bought is that a missing or unreadable tree is not a
 * failure at all: no release means `latest = null`, which the shared version
 * comparison renders as `unknown` (never a false "outdated"), and an update
 * request answers 409 with a sentence instead of 500.
 *
 * The repo-relative fallback below exists so the monorepo — `bun run dev`, the
 * compose stack, a single-container image — needs no configuration.
 */

/** One built binary. `path` is a PATH under our own origin, never a URL. */
export interface AgentReleaseArtifact {
  os: string;
  arch: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface PublishedRelease {
  version: string;
  artifacts: AgentReleaseArtifact[];
}

/** One published version directory, as the source found it. */
export interface PublishedVersion {
  version: string;
  dir: string;
}

/** The seam a spec replaces, so nothing here needs a filesystem. */
export interface AgentReleaseSource {
  /** Published versions, newest first. */
  list(): readonly PublishedVersion[];
  /** Raw `manifest.json` for a version, or null when it cannot be read. */
  read(entry: PublishedVersion): string | null;
}

export const AGENT_RELEASE_SOURCE = Symbol("AGENT_RELEASE_SOURCE");

/** Names the directory holding `<version>/manifest.json`. */
const RELEASE_DIR_ENV = "AGENT_RELEASE_DIR";

/**
 * Fallbacks for a checkout, relative to `process.cwd()` — which is the api
 * workspace directory in every way this app runs (`bun run --cwd apps/api`,
 * tests, and the image's `WORKDIR /app/apps/api`). Both roots are searched and the
 * newest version across them wins, exactly as the web does it: `vite dev` serves
 * `static/`, a built server serves `build/client/`, and a developer's checkout
 * has both.
 */
const FALLBACK_ROOTS = ["../web/build/client/agent", "../web/static/agent"] as const;

/**
 * Re-reading the tree on every dashboard render would stat a directory per host
 * per request. Releases change when somebody deploys, so a short TTL is free.
 */
const SNAPSHOT_TTL_MS = 30_000;

function releaseRoots(): string[] {
  const configured = process.env[RELEASE_DIR_ENV];
  if (configured && configured.length > 0) return [resolve(configured)];
  return FALLBACK_ROOTS.map((root) => resolve(process.cwd(), root));
}

export const fileSystemAgentReleases: AgentReleaseSource = {
  list(): readonly PublishedVersion[] {
    const found = new Map<string, PublishedVersion>();
    for (const dir of releaseRoots()) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // An absent root is the normal state of a checkout that never ran the Go
        // build. Not an error — try the next one.
        continue;
      }
      for (const entry of entries) {
        // First root wins a duplicate, and a directory that is not a version is
        // not a release: `parseSemver` is the same reader that later compares it.
        if (entry.isDirectory() && parseSemver(entry.name) !== null && !found.has(entry.name)) {
          found.set(entry.name, { version: entry.name, dir: join(dir, entry.name) });
        }
      }
    }
    return [...found.values()].sort((a, b) => compareVersionStrings(b.version, a.version) ?? 0);
  },

  read(entry: PublishedVersion): string | null {
    try {
      return readFileSync(join(entry.dir, "manifest.json"), "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * Platform names as the AGENT reports them, mapped to the names the build tool
 * uses.
 *
 * WHY THIS IS NOT A NO-OP: the Go agent reports `runtime.GOOS`/`GOARCH`, which is
 * what the artifacts are named after, but a host row can still hold what the
 * previous Node agent reported — `process.arch` says `x64` where Go says `amd64`.
 * Without this map every such host matches no artifact, reads as `unknown`
 * forever, and cannot be offered the update that would fix it.
 */
const ARCH_ALIASES: Readonly<Record<string, string>> = {
  x64: "amd64",
  x86_64: "amd64",
  amd64: "amd64",
  aarch64: "arm64",
  arm64: "arm64",
};

const OS_ALIASES: Readonly<Record<string, string>> = {
  linux: "linux",
  darwin: "darwin",
  macos: "darwin",
  win32: "windows",
  windows: "windows",
};

export interface Platform {
  os: string;
  arch: string;
}

/** null when the host has never said what it is — the caller renders `unknown`. */
export function normalizePlatform(os: string | null, arch: string | null): Platform | null {
  if (!os || !arch) return null;
  const key = { os: os.toLowerCase(), arch: arch.toLowerCase() };
  return { os: OS_ALIASES[key.os] ?? key.os, arch: ARCH_ALIASES[key.arch] ?? key.arch };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Parse one manifest, or return null.
 *
 * Never throws and never partially accepts: a manifest with one malformed entry
 * is a broken publish, and treating the rest as usable would offer a host an
 * artifact whose neighbours we already know we cannot read.
 */
export function parseReleaseManifest(raw: string, expectedVersion: string): PublishedRelease | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const manifest = payload as Record<string, unknown>;
  // The directory name and the declared version must agree, or the checksums
  // describe a different set of files than the paths do.
  if (manifest["version"] !== expectedVersion) return null;
  const entries = manifest["artifacts"];
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const artifacts: AgentReleaseArtifact[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const { os, arch, path, sha256 } = entry as Record<string, unknown>;
    const bytes = readNumber((entry as Record<string, unknown>)["bytes"]);
    if (
      typeof os !== "string" ||
      typeof arch !== "string" ||
      typeof path !== "string" ||
      typeof sha256 !== "string" ||
      bytes === null
    ) {
      return null;
    }
    artifacts.push({ os, arch, path, sha256, bytes });
  }
  return { version: expectedVersion, artifacts };
}

/** Either an artifact to send, or the sentence explaining why there is none. */
export type ArtifactLookup =
  | { artifact: AgentReleaseArtifact; version: string; reason: null }
  | { artifact: null; version: null; reason: string };

export class AgentReleaseService {
  private readonly logger = new ProductLogger(AgentReleaseService.name);
  private cache: { releases: PublishedRelease[]; at: number } | null = null;

  constructor(private readonly source: AgentReleaseSource) {}

  /** Every readable release, newest first. */
  releases(now: number = Date.now()): PublishedRelease[] {
    if (this.cache && now - this.cache.at < SNAPSHOT_TTL_MS) return this.cache.releases;
    const releases: PublishedRelease[] = [];
    for (const entry of this.source.list()) {
      const raw = this.source.read(entry);
      if (raw === null) {
        this.logger.warn(`Agent release ${entry.version} has no readable manifest`);
        continue;
      }
      const release = parseReleaseManifest(raw, entry.version);
      if (!release) {
        this.logger.warn(`Agent release ${entry.version} has an unusable manifest`);
        continue;
      }
      releases.push(release);
    }
    this.cache = { releases, at: now };
    return releases;
  }

  /**
   * The newest version that actually ships a build for this platform.
   *
   * ⚠ PER (OS, ARCH), NOT "THE NEWEST RELEASE". A release cut without a
   * darwin/arm64 binary must not paint every Mac amber and then offer it nothing
   * to install — so the scan walks versions newest-first and stops at the first
   * one that covers the platform.
   */
  latestFor(os: string | null, arch: string | null): string | null {
    const platform = normalizePlatform(os, arch);
    if (!platform) return null;
    for (const release of this.releases()) {
      if (this.findArtifact(release, platform)) return release.version;
    }
    return null;
  }

  /**
   * The artifact to send to this host: a named version, or the newest that covers
   * its platform.
   */
  resolve(os: string | null, arch: string | null, version?: string | null): ArtifactLookup {
    const platform = normalizePlatform(os, arch);
    if (!platform) {
      return {
        artifact: null,
        version: null,
        reason: "This host has not reported its platform yet, so there is no build to send it.",
      };
    }
    const releases = this.releases();
    if (releases.length === 0) {
      return {
        artifact: null,
        version: null,
        reason: "This deployment publishes no pdmux-agent build, so there is nothing to install.",
      };
    }
    const target = version
      ? releases.find((release) => release.version === version)
      : releases.find((release) => this.findArtifact(release, platform) !== null);
    if (!target) {
      return {
        artifact: null,
        version: null,
        reason: version
          ? `This deployment publishes no pdmux-agent ${version}.`
          : `No published pdmux-agent build covers ${platform.os}/${platform.arch}.`,
      };
    }
    const artifact = this.findArtifact(target, platform);
    if (!artifact) {
      return {
        artifact: null,
        version: null,
        reason: `pdmux-agent ${target.version} has no ${platform.os}/${platform.arch} build.`,
      };
    }
    return { artifact, version: target.version, reason: null };
  }

  /** Both sides go through the alias map, so a manifest written with `x64` and a
   *  host reporting `amd64` still meet. */
  private findArtifact(release: PublishedRelease, platform: Platform): AgentReleaseArtifact | null {
    for (const artifact of release.artifacts) {
      const built = normalizePlatform(artifact.os, artifact.arch);
      if (built && built.os === platform.os && built.arch === platform.arch) return artifact;
    }
    return null;
  }
}
