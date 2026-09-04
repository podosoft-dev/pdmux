import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function repositoryFile(relativePath: string): string {
  for (const root of [process.cwd(), resolve(process.cwd(), "../..")]) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Repository file not found: ${relativePath}`);
}

const workflow = readFileSync(repositoryFile(".github/workflows/release.yml"), "utf8");
const desktopWorkflow = readFileSync(repositoryFile(".github/workflows/desktop.yml"), "utf8");
const ciWorkflow = readFileSync(repositoryFile(".github/workflows/ci.yml"), "utf8");

describe("release workflow", () => {
  test("[TC-PDHOST-024] preserves multi-architecture images and agent assets", () => {
    for (const fragment of [
      "bun-version: 1.4.0",
      "workflow_dispatch:",
      "releaseTag:",
      "ref: ${{ inputs.releaseTag || github.ref }}",
      "RELEASE_TAG: ${{ inputs.releaseTag || github.ref_name }}",
      "Release tag must be a plain vX.Y.Z tag",
      "bun ci",
      "arch: amd64",
      "runner: ubuntu-latest",
      "arch: arm64",
      "runner: ubuntu-24.04-arm",
      "push-by-digest=true",
      "provenance: false",
      "docker buildx imagetools create",
      'expected 2 digests for $repo',
      "password: ${{ secrets.GITHUB_TOKEN }}",
      "bun tools/build-agent-binaries.mjs",
      "for arch in amd64 arm64",
      "pdmux-agent-*",
      "SHA256SUMS",
      "manifest.json",
      "tag_name: ${{ needs.verify.outputs.tag }}",
      "uses: ./.github/workflows/desktop.yml",
      "needs: [verify, build, desktop]",
      "pattern: pdmux-*",
      "bun tools/merge-desktop-update-metadata.mjs",
      "DESKTOP-SHA256SUMS",
      "/tmp/desktop/*",
    ]) {
      expect(workflow).toContain(fragment);
    }

    expect(workflow.match(/uses: oven-sh\/setup-bun@v2/g)).toHaveLength(2);

    expect(workflow).not.toContain("secrets.REGISTRY_USERNAME");
    expect(workflow).not.toContain("secrets.REGISTRY_PASSWORD");
    expect(workflow).not.toContain("npm ci");
  });

  test("[TC-PDDESKTOP-009] publishes only native desktop distributables", () => {
    for (const fragment of [
      "workflow_call:",
      "runner: macos-15-intel",
      "runner: macos-15",
      "runner: windows-2025",
      "runner: ubuntu-24.04",
      "latest-mac-${{ matrix.artifact }}.yml",
      "apps/desktop/release/*.AppImage",
      "apps/desktop/release/*.dmg",
      "apps/desktop/release/*.exe",
      "apps/desktop/release/latest*.yml",
    ]) {
      expect(desktopWorkflow).toContain(fragment);
    }
    expect(desktopWorkflow).not.toContain("path: apps/desktop/release/**");
  });

  test("[TC-PDHOST-024] rejects committed agent metadata that is stale", () => {
    for (const fragment of [
      "Capture committed agent metadata",
      'git show HEAD:"$dir/SHA256SUMS"',
      "del(.builtAt)",
      "Committed agent checksums differ from this source",
      "Committed agent manifest differs from this source",
    ]) {
      expect(ciWorkflow).toContain(fragment);
    }
  });
});
