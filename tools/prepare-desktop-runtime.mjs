#!/usr/bin/env bun
import { seedDesktopAgents } from "./seed-desktop-agents.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { stageDesktopRuntime } from "../apps/desktop/src/staging.ts";

const root = resolve(import.meta.dirname, "..");
await import("./build-desktop-api.mjs");
await import("./build-desktop-web.mjs");
const result = await stageDesktopRuntime({
  repositoryRoot: root,
  bunExecutable: process.execPath,
});
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
await seedDesktopAgents(join(root, "apps/desktop/resources/services/web/client/agent", result.agentVersion), { releaseTag: `v${version}` });
process.stdout.write(
  `Prepared desktop runtime with ${result.bunDestination} and agent ${result.agentVersion}\n`,
);
