import { expect, test } from "@playwright/test";
import { e2eAdminState } from "../helpers/accounts";

/**
 * What the API publishes must be what the web tier can hand over.
 *
 * REPORTED, and from the far end rather than the near one: an operator pressed
 * "update" on the dashboard, answered the shell-pane confirmation, and nothing
 * happened. The command was accepted, reached the agent, and the agent recorded
 * `DOWNLOAD_FAILED — the server answered 404 Not Found for the artifact`. Every
 * button, every guard and every frame on that path was correct.
 *
 * The two halves simply disagreed about where releases live. `fileSystemAgentReleases`
 * searches `../web/build/client/agent` and `../web/static/agent` and takes the newest
 * across both; the thing that actually serves bytes is one server with one root —
 * `vite dev` reads `static/`, a built server reads `build/client/`. In a container
 * that bakes a production build and then runs `vite dev`, the API listed a version out
 * of a directory no request could reach. The agent binaries are `.gitignore`d build
 * output, so `static/agent` was not merely stale, it was absent.
 *
 * ⚠ NO UNIT TEST CAN HOLD THIS. The listing side and the serving side are different
 * processes with different roots; the defect is the relationship between them, and it
 * only exists once both are running. That is why it is here and not in
 * `agent-release.service.spec.ts`, which passed throughout.
 */
const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

interface HostRow {
  label: string;
  os: string | null;
  arch: string | null;
  latestAgentVersion: string | null;
}

interface Manifest {
  version: string;
  artifacts: { os: string; arch: string; path: string; sha256: string }[];
}

test.describe("[TC-PDAGENT-127] a published agent release is one the web tier can serve", () => {
  test("every version the dashboard offers is fetchable at the path the agent is given", async ({ playwright }) => {
    // The isolated e2e account's stored session, NOT a sign-in as `admin@example.com`:
    // a person has this dashboard open, and every sign-in against their account revokes
    // the session in their browser (`live-stack.md`). This spec only reads.
    const ctx = await playwright.request.newContext({
      baseURL: base,
      extraHTTPHeaders: { origin: base },
      storageState: e2eAdminState,
    });

    const hosts = (await (await ctx.get("/api/hosts")).json()) as HostRow[];
    const offered = [...new Set(hosts.map((host) => host.latestAgentVersion).filter((v): v is string => !!v))];

    // A stack with no build published is a legitimate state — that is what the
    // dashboard's "no published build for that platform" exists to say. But then
    // nothing may be OFFERED either, which is the half that was broken: the offer
    // was made and the bytes were not there.
    if (offered.length === 0) {
      test.skip(true, "no agent release is published on this stack, so there is no offer to check");
      return;
    }

    for (const version of offered) {
      // The manifest is what the update service reads to resolve `artifactPath`, so
      // an unreachable manifest is already the bug even before any binary is asked for.
      const manifestUrl = `/agent/${version}/manifest.json`;
      const manifestRes = await ctx.get(manifestUrl);
      expect(
        manifestRes.status(),
        `${manifestUrl} — the API offers ${version} but the web tier cannot serve its manifest`,
      ).toBe(200);

      const manifest = (await manifestRes.json()) as Manifest;
      expect(manifest.version, `${manifestUrl} describes a different version`).toBe(version);
      expect(manifest.artifacts.length, `${version} publishes no artifacts`).toBeGreaterThan(0);

      for (const artifact of manifest.artifacts) {
        // HEAD, not GET: four binaries per version at ~8MB each is 32MB of body to
        // prove a routing fact. Verified to discriminate on this path — a missing
        // version answers 404 to HEAD just as it does to GET.
        const res = await ctx.head(artifact.path);
        expect(
          res.status(),
          `${artifact.path} — offered as ${version} for ${artifact.os}/${artifact.arch}, and the agent would get ${res.status()}`,
        ).toBe(200);
      }
    }

    // And the platform each host actually runs must be among what is published, or the
    // dashboard is offering that host an update it can never take.
    for (const host of hosts) {
      if (!host.latestAgentVersion || !host.os || !host.arch) continue;
      const manifest = (await (await ctx.get(`/agent/${host.latestAgentVersion}/manifest.json`)).json()) as Manifest;
      expect(
        manifest.artifacts.some((a) => a.os === host.os && a.arch === host.arch),
        `${host.label} is ${host.os}/${host.arch} and ${host.latestAgentVersion} publishes no such build`,
      ).toBe(true);
    }

    await ctx.dispose();
  });
});
