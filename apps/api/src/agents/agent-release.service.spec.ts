import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, agentVersionState } from "@pdmux/protocol";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import {
  AgentReleaseService,
  normalizePlatform,
  parseReleaseManifest,
  type AgentReleaseSource,
  type PublishedRelease,
  type PublishedVersion,
} from "./agent-release.service";

function artifact(version: string, os: string, arch: string): PublishedRelease["artifacts"][number] {
  return {
    os,
    arch,
    path: `/agent/${version}/pdmux-agent-${os}-${arch}`,
    sha256: "a".repeat(64),
    bytes: 9_000_000,
  };
}

/** 1.3.0 dropped the Mac build; 1.2.0 still has one. */
const RELEASES: PublishedRelease[] = [
  { version: "1.2.0", artifacts: [artifact("1.2.0", "linux", "amd64"), artifact("1.2.0", "darwin", "arm64")] },
  { version: "1.3.0", artifacts: [artifact("1.3.0", "linux", "amd64")] },
];

describe("[TC-PDHOST-011] the published release a host is measured against", () => {
  it("resolves the newest version PER platform, not the newest release", () => {
    const releases = fakeAgentReleases(RELEASES);

    expect(releases.latestFor("linux", "amd64")).toBe("1.3.0");
    // The Mac must not read as outdated against a release that ships it nothing.
    expect(releases.latestFor("darwin", "arm64")).toBe("1.2.0");
    // A platform nothing was ever built for has no answer at all.
    expect(releases.latestFor("windows", "amd64")).toBeNull();
    // Neither does a host that has not said what it is.
    expect(releases.latestFor(null, null)).toBeNull();
  });

  it("feeds a version state that never says 'outdated' on a guess", () => {
    const releases = fakeAgentReleases(RELEASES);
    const state = (agentVersion: string | null, os: string, arch: string, protocolVersion: number | null) =>
      agentVersionState({
        agentVersion,
        protocolVersion,
        latest: releases.latestFor(os, arch),
        protocolVersionSupported: PROTOCOL_VERSION,
      });

    expect(state("1.3.0", "linux", "amd64", PROTOCOL_VERSION)).toBe("current");
    expect(state("1.2.0", "linux", "amd64", PROTOCOL_VERSION)).toBe("outdated");
    expect(state("1.4.0", "linux", "amd64", PROTOCOL_VERSION)).toBe("ahead");
    // The Mac on 1.2.0 is CURRENT — 1.3.0 exists but not for it.
    expect(state("1.2.0", "darwin", "arm64", PROTOCOL_VERSION)).toBe("current");
    // Nothing published for the platform, an unreadable version, or a host that
    // has never connected: all "we cannot say", never "behind".
    expect(state("1.2.0", "windows", "amd64", PROTOCOL_VERSION)).toBe("unknown");
    expect(state("nightly", "linux", "amd64", PROTOCOL_VERSION)).toBe("unknown");
    expect(state(null, "linux", "amd64", null)).toBe("unknown");
    // A different wire contract is the one hard statement.
    expect(state("1.3.0", "linux", "amd64", PROTOCOL_VERSION + 1)).toBe("incompatible");
  });

  it("reads the platform names the previous agent used", () => {
    expect(normalizePlatform("linux", "x64")).toEqual({ os: "linux", arch: "amd64" });
    expect(normalizePlatform("Darwin", "ARM64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(normalizePlatform("linux", "aarch64")).toEqual({ os: "linux", arch: "arm64" });
    // Unknown names pass through lower-cased rather than being dropped: a future
    // GOARCH must not become "this host has no platform".
    expect(normalizePlatform("freebsd", "riscv64")).toEqual({ os: "freebsd", arch: "riscv64" });
    expect(normalizePlatform(null, "amd64")).toBeNull();
  });

  it("refuses a manifest it cannot fully trust, rather than half of it", () => {
    const good = JSON.stringify({ version: "1.2.0", artifacts: [artifact("1.2.0", "linux", "amd64")] });
    expect(parseReleaseManifest(good, "1.2.0")?.artifacts).toHaveLength(1);

    const cases: [string, string][] = [
      ["not json", "1.2.0"],
      [JSON.stringify({ version: "1.2.0", artifacts: [] }), "1.2.0"],
      [JSON.stringify({ version: "1.2.0" }), "1.2.0"],
      // The directory name and the declared version disagree: the checksums then
      // describe a different set of files than the paths do.
      [good, "1.3.0"],
      // One malformed entry poisons the manifest — its neighbours came from the
      // same publish.
      [
        JSON.stringify({
          version: "1.2.0",
          artifacts: [artifact("1.2.0", "linux", "amd64"), { os: "darwin", arch: "arm64", path: "/x" }],
        }),
        "1.2.0",
      ],
      [
        JSON.stringify({ version: "1.2.0", artifacts: [{ ...artifact("1.2.0", "linux", "amd64"), bytes: 0 }] }),
        "1.2.0",
      ],
    ];
    for (const [raw, version] of cases) expect(parseReleaseManifest(raw, version)).toBeNull();
  });

  it("survives a deployment that publishes nothing", () => {
    const releases = fakeAgentReleases([]);
    expect(releases.releases()).toEqual([]);
    expect(releases.latestFor("linux", "amd64")).toBeNull();
    const lookup = releases.resolve("linux", "amd64");
    expect(lookup.artifact).toBeNull();
    expect(lookup.reason).toContain("publishes no pdmux-agent build");
  });

  it("skips an unreadable version without losing the readable ones", () => {
    const source: AgentReleaseSource = {
      list: (): readonly PublishedVersion[] => [
        { version: "1.3.0", dir: "/fake/1.3.0" },
        { version: "1.2.0", dir: "/fake/1.2.0" },
      ],
      read: (entry: PublishedVersion): string | null =>
        entry.version === "1.3.0"
          ? null // half-copied release directory
          : JSON.stringify({ version: "1.2.0", artifacts: [artifact("1.2.0", "linux", "amd64")] }),
    };
    const releases = new AgentReleaseService(source);
    expect(releases.latestFor("linux", "amd64")).toBe("1.2.0");
  });

  it("caches the tree, so painting a fleet does not re-read it per host", () => {
    let reads = 0;
    const source: AgentReleaseSource = {
      list: (): readonly PublishedVersion[] => [{ version: "1.2.0", dir: "/fake/1.2.0" }],
      read: (): string => {
        reads += 1;
        return JSON.stringify({ version: "1.2.0", artifacts: [artifact("1.2.0", "linux", "amd64")] });
      },
    };
    const releases = new AgentReleaseService(source);
    const start = Date.now();
    for (let index = 0; index < 50; index += 1) releases.releases(start);
    expect(reads).toBe(1);
    // A deploy publishes a new build; the TTL is what lets it appear.
    releases.releases(start + 60_000);
    expect(reads).toBe(2);
  });
});

/**
 * ⚠ THIS ONE ASSERTS ABOUT THE IMAGE, NOT ABOUT A FUNCTION, and it is here
 * because the defect it guards was invisible to every other kind of test.
 *
 * `AgentReleaseService` falls back to `../web/static/agent`, which exists in a
 * checkout — so unit tests, the dev server and a single-image run all find
 * releases. Production splits the images, `.dockerignore` keeps that tree out of
 * the build context entirely, and the api image had no agent stage: the service
 * saw ZERO releases, every host's badge went `unknown`, and the dashboard never
 * offered an update. Measured on the deployed container: `list()` returned 0.
 *
 * Nothing failed. `unknown` is the correct rendering of "we cannot say", so the
 * screen looked calm while the feature was absent — for every release since the
 * first deploy. A document assertion is the only place this can be caught before
 * somebody notices in production.
 */
describe("[TC-PDHOST-022] the image the api actually ships carries the releases", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "..", "Dockerfile"), "utf8");

  it("builds the manifests in the image rather than trusting a checkout", () => {
    // Built here, NOT copied from the repository: the committed tree carries
    // every version ever built, while the web image serves only what its own
    // agent stage produced for this release. Advertising a version the web tier
    // answers 404 for makes the agent accept an update and then report
    // DOWNLOAD_FAILED — worse than offering nothing.
    expect(dockerfile).toMatch(/FROM\s+\S+\s+AS agent/);
    expect(dockerfile).toContain("bun tools/build-agent-binaries.mjs");
    expect(dockerfile).not.toMatch(/COPY\s+apps\/web\/static\/agent/);
  });

  it("puts them where the runtime stage is told to look", () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("AS runtime"));
    const copied = runtime.match(/COPY --from=agent \S+ \.\/(\S+)/);
    const configured = runtime.match(/ENV AGENT_RELEASE_DIR=(\S+)/);
    expect(copied).not.toBeNull();
    expect(configured).not.toBeNull();
    // The two halves are useless apart, and nothing at runtime complains when
    // they disagree — an unreadable root is the normal state of a checkout, so
    // the service treats it as "no releases" and says nothing.
    expect(configured?.[1]).toBe(`/app/${copied?.[1]}`);
  });

  it("keeps the binaries out — this tier never serves them", () => {
    // ~30MB of Go output that only the web image publishes. Shipping it here
    // would be invisible waste on every pull of every release.
    expect(dockerfile).toContain("! -name manifest.json -delete");
  });
});
