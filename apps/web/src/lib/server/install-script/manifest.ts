/**
 * Finding the agent release the installer should hand out.
 *
 * The release pipeline (tools/build-agent-binaries.mjs) writes
 * `apps/web/static/agent/<version>/{pdmux-agent-<os>-<arch>, SHA256SUMS, manifest.json}`
 * and Vite copies `static/` into `build/client/`, so those files are served by this
 * same origin at `/agent/<version>/…`. There is no object store and no second
 * hostname — which is the entire reason the installer can be one line.
 *
 * ⚠ WHY THIS READS THE FILESYSTEM AND NOT `event.fetch`.
 *
 * `event.fetch('/agent/<v>/manifest.json')` LOOKS like an internal lookup, and for a
 * static asset it is not one. SvelteKit's server fetch only short-circuits an asset
 * when `state.read` is set (prerendering) or when the file is a `$app/server` server
 * asset; a plain file in `static/` is neither, so it falls through to a real
 * `fetch(request)` against `event.url.origin`. Measured on a built server whose
 * public HTTPS origin differed from its plain-HTTP listener, that produced:
 *
 *   TypeError: fetch failed
 *     cause: Error: …SSL routines:tls_validate_record_header:wrong version number
 *
 * — the app dialling itself over TLS on an http port, because `event.url.origin` is
 * a guess. With `ORIGIN` set it is worse rather than better: the request leaves the
 * box, crosses the proxy and may land on a different replica. `readFileSync` has
 * neither failure mode, costs no round trip, and reads the very bytes the static
 * middleware would have served (in the image, `build/client` IS the directory sirv
 * serves), so the "are the release files actually present" question is still
 * answered — structurally, instead of over the network.
 *
 * `/agent/manifest.json` is not an option at all: the builder writes one manifest
 * PER VERSION, so that path 404s on every deployment.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVersionStrings, parseSemver } from "@pdmux/protocol";
import type { InstallScriptArtifact } from "./render";

export type AgentRelease = {
  version: string;
  artifacts: InstallScriptArtifact[];
};

/** Either a release to publish, or the reason there is none — never both. */
export type AgentReleaseLookup =
  | { release: AgentRelease; reason: null }
  | { release: null; reason: string };

/** One published version directory. */
export type PublishedVersion = { version: string; dir: string };

/** The seam the route's tests replace, so nothing here needs a filesystem. */
export type AgentReleaseSource = {
  /** Published versions, newest first. */
  list(): readonly PublishedVersion[];
  /** Raw `manifest.json` for a published version, or null when it cannot be read. */
  read(entry: PublishedVersion): string | null;
};

/**
 * Where the published agent tree can live.
 *
 * Both are searched and the newest version across them wins, because which one is
 * authoritative depends on how the app was started and there is no reliable way to
 * ask: `vite dev` serves `static/`, the built server serves `build/client/`, and a
 * developer's checkout can have both. Merging removes the trap in both directions —
 * and in the production image only the second exists, because the runtime stage
 * ships `apps/web/build` and nothing else.
 *
 * Relative to `process.cwd()`, which is the web workspace directory in every way
 * this app runs: `vite dev`, `vite preview`, `vitest` (all through
 * `bun run --cwd apps/web …`), and `bun ./build` under the image's
 * `WORKDIR /app/apps/web`.
 */
const AGENT_ROOTS = ["build/client/agent", "static/agent"] as const;

const NO_RELEASE =
  "This deployment publishes no pdmux-agent build, so there is nothing to install. " +
  "The release binaries come from `bun run build:agent` and are baked into the web image.";

export const fileSystemReleaseSource: AgentReleaseSource = {
  list(): readonly PublishedVersion[] {
    const found = new Map<string, PublishedVersion>();
    for (const root of AGENT_ROOTS) {
      const dir = resolve(process.cwd(), root);
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // Absent root: a checkout that never ran the Go build, or `static/` inside
        // the production image. Not an error — try the next one.
        continue;
      }
      for (const entry of entries) {
        // First root wins a duplicate: `build/client` is a copy of `static`, and the
        // built tree is the one a built server serves.
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

function readArtifacts(value: unknown): InstallScriptArtifact[] | null {
  if (!Array.isArray(value)) return null;
  const artifacts: InstallScriptArtifact[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { os, arch, path, sha256 } = entry as Record<string, unknown>;
    if (typeof os !== "string" || typeof arch !== "string" || typeof path !== "string" || typeof sha256 !== "string") {
      return null;
    }
    artifacts.push({ os, arch, path, sha256 });
  }
  return artifacts.length > 0 ? artifacts : null;
}

/**
 * The newest published release, or the reason there is none.
 *
 * Never throws: every failure becomes a `reason` the route prints into a script,
 * because an operator staring at `curl … | sh` needs a sentence, not a stack trace.
 * The reasons name the PUBLIC path (`/agent/<v>/manifest.json`), never the server's
 * own directory layout — an anonymous caller has no business learning that.
 */
export function loadAgentRelease(source: AgentReleaseSource = fileSystemReleaseSource): AgentReleaseLookup {
  const entry = source.list()[0];
  if (entry === undefined) return { release: null, reason: NO_RELEASE };

  const publicPath = `/agent/${entry.version}/manifest.json`;
  const raw = source.read(entry);
  if (raw === null) {
    return {
      release: null,
      reason: `This deployment has a pdmux-agent ${entry.version} directory but cannot read ${publicPath}, so the release files are incomplete.`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { release: null, reason: `The release manifest at ${publicPath} is not valid JSON.` };
  }
  if (typeof payload !== "object" || payload === null) {
    return { release: null, reason: `The release manifest at ${publicPath} is not a JSON object.` };
  }

  const manifest = payload as Record<string, unknown>;
  const artifacts = readArtifacts(manifest["artifacts"]);
  if (artifacts === null) {
    return { release: null, reason: `The release manifest at ${publicPath} lists no usable artifacts.` };
  }
  // The two must agree, or the checksums describe a different set of files than the
  // paths do — the one inconsistency a baked-checksum installer cannot survive.
  if (manifest["version"] !== entry.version) {
    return { release: null, reason: `The release manifest at ${publicPath} declares a different version.` };
  }

  return { release: { version: entry.version, artifacts }, reason: null };
}
