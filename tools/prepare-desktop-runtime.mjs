#!/usr/bin/env bun
import { resolve } from "node:path";
import { stageDesktopRuntime } from "../apps/desktop/src/staging.ts";

const root = resolve(import.meta.dirname, "..");
const result = await stageDesktopRuntime({
  repositoryRoot: root,
  bunExecutable: process.execPath,
});
process.stdout.write(
  `Prepared desktop runtime with ${result.bunDestination} and agent ${result.agentVersion}\n`,
);
