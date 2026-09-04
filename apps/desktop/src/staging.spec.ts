import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageDesktopRuntime } from "./staging.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

describe("[TC-PDDESKTOP-009] desktop runtime staging", () => {
  it("keeps only runtime entries and the current host-agent release", async () => {
    root = await mkdtemp(join(tmpdir(), "pdmux-desktop-stage-"));
    await Promise.all([
      fixture(join(root, "apps/api/dist/main.js"), "api"),
      fixture(join(root, "apps/api/dist/migrate.js"), "migrate"),
      fixture(join(root, "apps/api/dist/main-worker.js"), "worker"),
      fixture(join(root, "apps/web/build/index.js"), "web"),
      fixture(join(root, "apps/web/build/client/agent/0.1.23/manifest.json"), "old"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/manifest.json"), "current"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/SHA256SUMS"), "checksums"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/pdmux-agent-linux-amd64"), "agent"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/pdmux-agent-linux-arm64"), "agent"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/pdmux-agent-darwin-amd64"), "agent"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/pdmux-agent-darwin-arm64"), "agent"),
      fixture(join(root, "agent/internal/cli/version.go"), 'package cli\nvar AgentVersion = "0.1.24"\n'),
      fixture(join(root, "bun"), "runtime"),
      mkdir(join(root, "apps/desktop/resources"), { recursive: true }),
    ]);

    const result = await stageDesktopRuntime({
      repositoryRoot: root,
      bunExecutable: join(root, "bun"),
      platform: "linux",
    });

    expect(result).toEqual({ agentVersion: "0.1.24", bunDestination: "bun" });
    expect((await readdir(join(root, "apps/desktop/resources/services/api"))).sort()).toEqual([
      "main.js",
      "migrate.js",
    ]);
    expect(await readdir(join(root, "apps/desktop/resources/services/web/client/agent"))).toEqual([
      "0.1.24",
    ]);
    expect(await readFile(join(root, "apps/desktop/resources/bin/bun"), "utf8")).toBe("runtime");
  });

  it("rejects a web build without the current agent binaries", async () => {
    root = await mkdtemp(join(tmpdir(), "pdmux-desktop-stage-"));
    await Promise.all([
      fixture(join(root, "apps/api/dist/main.js"), "api"),
      fixture(join(root, "apps/api/dist/migrate.js"), "migrate"),
      fixture(join(root, "apps/web/build/client/agent/0.1.24/manifest.json"), "current"),
      fixture(join(root, "agent/internal/cli/version.go"), 'package cli\nvar AgentVersion = "0.1.24"\n'),
      fixture(join(root, "bun"), "runtime"),
      mkdir(join(root, "apps/desktop/resources"), { recursive: true }),
    ]);

    await expect(stageDesktopRuntime({
      repositoryRoot: root,
      bunExecutable: join(root, "bun"),
      platform: "linux",
    })).rejects.toThrow("Web build is missing agent 0.1.24/SHA256SUMS");
  });
});
