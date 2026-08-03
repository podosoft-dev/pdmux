import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_VERSION } from "./version";

/**
 * The repo version is only a single source of truth while the workspaces agree with
 * it. `SERVER_VERSION` reads this app's own package.json, so a workspace left behind
 * at 0.0.0 would make the API report a different number from the one in the UI and
 * the changelog — the drift these assertions exist to catch, at `npm test` rather
 * than in a bug report about a dashboard footer.
 *
 * ⚠ UNTAGGED ON PURPOSE. TC ids are allocated centrally, no declared id covers
 * repo versioning yet, and an invented tag fails the traceability check.
 */
const REPO_ROOT = join(__dirname, "../../..");

function versionOf(workspace: string): string {
  const raw = readFileSync(join(REPO_ROOT, workspace, "package.json"), "utf8");
  return (JSON.parse(raw) as { version?: string }).version ?? "";
}

describe("repo version", () => {
  const root = versionOf(".");

  it("is a plain SemVer release, not a placeholder", () => {
    expect(root).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(root).not.toBe("0.0.0");
  });

  it("is what the API reports to an agent in `welcome`", () => {
    expect(SERVER_VERSION).toBe(root);
    // The contract caps the field; a longer string would cost the agent its welcome.
    expect(SERVER_VERSION.length).toBeLessThanOrEqual(32);
  });

  // The host agent is absent on purpose: it is a Go module with its own release
  // number (agent/internal/cli/version.go, gated by the CI bump check), not an npm
  // workspace, so it neither has nor should have a package.json carrying this one.
  it.each([
    "apps/api",
    "apps/web",
    "packages/protocol",
    "packages/core",
    "packages/ui",
    "tests",
  ])("workspace %s carries the repo version", (workspace) => {
    expect(versionOf(workspace)).toBe(root);
  });
});
