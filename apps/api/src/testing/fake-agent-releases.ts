import { compareVersionStrings } from "@pdmux/protocol";
import {
  AgentReleaseService,
  type AgentReleaseSource,
  type PublishedRelease,
  type PublishedVersion,
} from "../agents/agent-release.service";

/**
 * An `AgentReleaseService` over in-memory manifests.
 *
 * WHY IT EXISTS: every spec that builds a `HostsService` now needs one, and
 * almost none of them care about releases — they care about rows. Handing them a
 * source with nothing published keeps those specs honest (no release means the
 * version state is `unknown`, which is what an unconfigured deployment really
 * shows) without a temp directory each.
 *
 * The manifests are serialised and re-parsed rather than injected as objects, so
 * a spec exercises the same reader the filesystem source feeds — a manifest this
 * helper accepts is one the real one would too.
 */
export function fakeAgentReleases(releases: PublishedRelease[] = []): AgentReleaseService {
  const source: AgentReleaseSource = {
    // Newest first, as the filesystem source promises — so a spec may list its
    // releases in whatever order reads best.
    list(): readonly PublishedVersion[] {
      return [...releases]
        .sort((a, b) => compareVersionStrings(b.version, a.version) ?? 0)
        .map((release) => ({ version: release.version, dir: `/fake/${release.version}` }));
    },
    read(entry: PublishedVersion): string | null {
      const release = releases.find((candidate) => candidate.version === entry.version);
      return release ? JSON.stringify(release) : null;
    },
  };
  return new AgentReleaseService(source);
}
