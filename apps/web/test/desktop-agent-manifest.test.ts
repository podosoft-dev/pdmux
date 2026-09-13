import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileSystemReleaseSource } from "../src/lib/server/install-script/manifest";

it("[TC-PDDESKTOP-009] discovers only the explicitly staged agent release root", (): void => {
  const directory = mkdtempSync(join(tmpdir(), "pdmux-agent-manifest-"));
  try {
    mkdirSync(join(directory, "0.1.0"));
    writeFileSync(join(directory, "0.1.0/manifest.json"), '{"version":"0.1.0"}');
    vi.stubEnv("AGENT_RELEASE_DIR", directory);
    expect(fileSystemReleaseSource.list()).toEqual([{ version: "0.1.0", dir: join(directory, "0.1.0") }]);
    expect(fileSystemReleaseSource.read(fileSystemReleaseSource.list()[0]!)).toBe('{"version":"0.1.0"}');
    vi.stubEnv("AGENT_RELEASE_DIR", join(directory, "missing"));
    expect(fileSystemReleaseSource.list()).toEqual([]);
  } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
});
