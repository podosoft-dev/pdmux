import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { signingEnvironment } from "./apple-signing.mjs";
import { prepareAgentArtifacts } from "./agent-artifacts.mjs";
import { releaseMac } from "./release-macos-signing.mjs";

assert.equal(process.platform, "darwin", "Build signed local packages on macOS");
assert.notEqual(process.env.GITHUB_ACTIONS, "true", "CI must use the protected release workflow");
const repository = resolve(import.meta.dirname, "..");
const clean = signingEnvironment(process.env);
const agentRoot = join(repository, "apps/desktop/release-agent/agent");
const agents = await prepareAgentArtifacts({ signed: true, local: true, outputRoot: agentRoot });
for (const workspace of ["@pdmux/protocol", "@pdmux/core", "@pdmux/ui", "@pdmux/mcp", "pdmux-api", "pdmux-web", "pdmux-desktop"]) {
  execFileSync(process.execPath, ["run", "--filter", workspace, "build"], { cwd: repository, env: clean, stdio: "inherit", timeout: 600_000 });
}
execFileSync(process.execPath, ["run", "desktop:prepare"], { cwd: repository, env: clean, stdio: "inherit" });
const destination = join(repository, "apps/desktop/resources/services/web/client/agent");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(agents, join(destination, agents.split("/").pop()), { recursive: true });
await rm(join(repository, "apps/desktop/release"), { recursive: true, force: true });
await releaseMac({ local: true });
