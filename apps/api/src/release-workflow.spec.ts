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
const ciWorkflow = readFileSync(repositoryFile(".github/workflows/ci.yml"), "utf8");

describe("release workflow", () => {
  test("[TC-PDHOST-024] preserves multi-architecture images and agent assets", () => {
    for (const fragment of [
      "bun-version: 1.4.0",
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
    ]) {
      expect(workflow).toContain(fragment);
    }

    expect(workflow).not.toContain("secrets.REGISTRY_USERNAME");
    expect(workflow).not.toContain("secrets.REGISTRY_PASSWORD");
    expect(workflow).not.toContain("npm ci");
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
