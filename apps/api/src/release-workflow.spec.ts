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
  test("[TC-PDHOST-024] verifies native migration images without publishing from CI", () => {
    const job = ciWorkflow.match(/\n  migration-images:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:|$)/)?.[1] ?? "";
    for (const fragment of [
      "contents: read",
      "arch: amd64",
      "runner: ubuntu-latest",
      "machine: x86_64",
      "arch: arm64",
      "runner: ubuntu-24.04-arm",
      "machine: aarch64",
      'test "$(uname -m)" = "$EXPECTED_MACHINE"',
      "platforms: linux/${{ matrix.arch }}",
      "load: true",
      "push: false",
      'bun tools/check-api-image-migrations.mjs "$API_IMAGE"',
      'bun tools/test-migration-upgrade.mjs "$API_IMAGE"',
    ]) expect(job).toContain(fragment);
    expect(job).not.toContain("packages: write");
    expect(job).not.toContain("secrets.");
    expect(job).not.toContain("setup-qemu");
  });
  test("[TC-PDHOST-024] gates releases on upgrades and final-image migration discovery", () => {
    expect(ciWorkflow).toContain("bun run test:migrations");
    expect(workflow).toContain("bun run test:migrations");
    expect(workflow).toContain('bun tools/check-api-image-migrations.mjs "$API_IMAGE"');
    expect(workflow.indexOf("Verify migrations in the final API image"))
      .toBeLessThan(workflow.indexOf("Hand the digests to the publish job"));
    const buildScript = readFileSync(repositoryFile("apps/api/scripts/build.mjs"), "utf8");
    expect(buildScript).toContain("migrations.json");
  });
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
      "name: agent-binaries",
      "sha256sum -c SHA256SUMS",
      "for arch in amd64 arm64",
      "pdmux-agent-*",
      "SHA256SUMS",
      "manifest.json",
      "tag_name: ${{ needs.verify.outputs.tag }}",
      "uses: ./.github/workflows/desktop.yml",
      "source_ref: ${{ inputs.releaseTag || github.ref_name }}",
      "needs: [verify, agent, build, desktop]",
      "pattern: pdmux-*",
      "bun tools/merge-desktop-update-metadata.mjs",
      "DESKTOP-SHA256SUMS",
      "/tmp/desktop/*",
    ]) {
      expect(workflow).toContain(fragment);
    }

    expect(workflow.match(/uses: oven-sh\/setup-bun@v2/g)).toHaveLength(3);
    // The release attaches the agent bytes the installers embed instead of building them again.
    expect(workflow).not.toContain("build-agent-binaries");
    expect(workflow).not.toContain("actions/setup-go");

    expect(workflow).not.toContain("secrets.REGISTRY_USERNAME");
    expect(workflow).not.toContain("secrets.REGISTRY_PASSWORD");
    expect(workflow).not.toContain("npm ci");
  });

  test("[TC-PDDESKTOP-009] publishes only native desktop distributables", () => {
    for (const fragment of [
      "workflow_call:",
      "runner: macos-15-intel",
      "runner: macos-26",
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

    // One agent build feeds every installer, so all packages embed the same bytes.
    const agent = desktopWorkflow.match(/\n  agent:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[1] ?? "";
    const packageJob = desktopWorkflow.match(/\n  package:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[1] ?? "";
    expect(agent).toContain("uses: ./.github/workflows/agent-binaries.yml");
    const shared = readFileSync(repositoryFile(".github/workflows/agent-binaries.yml"), "utf8");
    expect(shared).toContain("bun tools/agent-artifacts.mjs --signed");
    expect(shared).toContain("name: agent-binaries");
    expect(workflow).toContain("agent_artifact: ${{ needs.agent.outputs.artifact_name }}");
    expect(workflow.match(/build-contexts: pdmux-agent-artifacts=/g)).toHaveLength(2);
    expect(workflow).toContain('bun tools/verify-agent-images.mjs "$API_IMAGE" "$WEB_IMAGE" "$AGENT_CONTEXT"');
    expect(workflow.indexOf("Verify agent distribution in final images")).toBeLessThan(workflow.indexOf("Hand the digests to the publish job"));
    expect(packageJob).toContain("needs: agent");
    expect(packageJob).toContain("inputs.agent_artifact || 'agent-binaries'");
    expect(packageJob).not.toContain("actions/setup-go");
    const preserveSource = 'cp -R apps/web/static/agent "$RUNNER_TEMP/agent-source"';
    expect(packageJob).toContain(preserveSource);
    expect(packageJob.indexOf(preserveSource)).toBeLessThan(packageJob.indexOf("tar -xf .agent-binaries/agent-binaries.tar"));
    expect(packageJob).toContain("PDMUX_AGENT_SOURCE_ROOT: ${{ runner.temp }}/agent-source");
  });

  test("[TC-PDDESKTOP-009] restricts stable signing to macOS releases and independently verifies artifacts", () => {
    expect(workflow).toContain("signed: true");
    expect(desktopWorkflow).toContain("'desktop-signing' || 'desktop-build'");
    expect(desktopWorkflow).toContain("runner.os == 'macOS' && inputs.signed");
    expect(desktopWorkflow).toContain("bun tools/release-macos-signing.mjs");
    expect(desktopWorkflow).toContain("bun tools/package-macos-desktop.mjs --ci-probe");
    expect(desktopWorkflow).not.toContain("DESKTOP_APPLE_");
    const verify = desktopWorkflow.split("\n  verify-macos:\n")[1] ?? "";
    expect(verify).toContain('bun tools/verify-macos-desktop.mjs "$PACKAGE_DIRECTORY" --runtime');
    expect(verify).not.toContain("secrets.");
    expect(verify).not.toContain("add-trusted-cert");
    expect(desktopWorkflow).toContain("bun tools/probe-macos-developer-id-update.mjs --verify");
    const updateVerifier = desktopWorkflow.match(/\n  verify-update-probe:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:|$)/)?.[1] ?? "";
    expect(updateVerifier).toContain("needs: prepare-update-probe");
    expect(updateVerifier).not.toContain("secrets.");
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
