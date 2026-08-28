import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");

const CURRENT_COMMAND_SURFACES = [
  "README.md",
  "README-ko.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "tools/demo-agent.mjs",
  "tools/preflight.sh",
  "tools/smoke-web-build.mjs",
  "tools/build-agent-binaries.mjs",
  "tools/build-file-icons.mjs",
  "tools/reset-e2e-data.mjs",
  "tools/generalization-audit.mjs",
  "packages/protocol/scripts/build-schema.mjs",
  "packages/protocol/scripts/build-expected.mjs",
  "packages/ui/src/icons/vscode-icons/SOURCE.md",
  "apps/api/scripts/bootstrap-admin.mjs",
  "apps/api/scripts/configure-auth.mjs",
  "apps/api/src/mcp/agent-kit.controller.ts",
  "infra/docker/docker-compose.yml",
  "infra/docker/sms-sink.mjs",
  "agent/internal/protocol/conformance_test.go",
  "agent/internal/protocol/schema/protocol.schema.json",
] as const;

const STALE_RUNTIME_COMMAND =
  /(^|\s)(npm\s+(?:run|test|install|ci)|npx\s+|node\s+\S+\.(?:mjs|js|ts))|^#!\/usr\/bin\/env node$/m;

describe("Bun toolchain commands", () => {
  it("keeps current scripts and user guidance free of Node and npm launch commands", () => {
    for (const path of CURRENT_COMMAND_SURFACES) {
      expect(read(path), path).not.toMatch(STALE_RUNTIME_COMMAND);
    }
  });

  it("loads the final terminal relay chunk during production smoke", () => {
    expect(read("tools/smoke-web-build.mjs")).toContain("src/lib/dashboard/terminal-relay.ts");
  });
});
