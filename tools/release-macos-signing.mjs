import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withAppleSigning } from "./apple-signing.mjs";
import { verifyAgentDirectory } from "./agent-artifacts.mjs";
import { finalizeMacArtifacts } from "./finalize-macos-artifacts.mjs";
import { packageMac } from "./package-macos-desktop.mjs";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";

export { assertReleaseContext, assertCertificate } from "./apple-signing.mjs";

export async function releaseMac({ local = false } = {}) {
  const repository = resolve(import.meta.dirname, "..");
  const version = parseAgentVersion(await readFile(join(repository, "agent/internal/cli/version.go"), "utf8"));
  await withAppleSigning(async context => {
    await verifyAgentDirectory(join(repository, "apps/desktop/resources/services/web/client/agent", version), {
      signed: true, native: true, subset: true, sourceDirectory: join(process.env.PDMUX_AGENT_SOURCE_ROOT ?? join(repository, "apps/web/static/agent"), version),
    });
    await packageMac(false, context);
    await finalizeMacArtifacts(join(repository, "apps/desktop/release"), context);
    console.log(JSON.stringify({ stage: "release-signing", certificateSha256: context.certificateSha256, result: "passed" }));
  }, { local });
}

if (import.meta.main) await releaseMac({ local: process.argv.includes("--local") });
