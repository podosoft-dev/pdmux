import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";

function isolatedEnvironment(environment) {
  // Hooks export repository-local Git variables. A cwd alone cannot isolate Git.
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("GIT_")));
}

function verifyCheckout(environment) {
    const root = mkdtempSync(join(tmpdir(), "pdmux-checkout-"));
    const repository = new URL("../", import.meta.url);
    const version = parseAgentVersion(readFileSync(new URL("agent/internal/cli/version.go", repository), "utf8"));
    const paths = ["agent/internal/protocol/schema/protocol.schema.json", "agent/internal/cli/version.go",
      `apps/web/static/agent/${version}/SHA256SUMS`, "apps/desktop/resources/tray.png"];
    try {
      const git = args => execFileSync("git", args, { cwd: root, stdio: "pipe", env: isolatedEnvironment(environment) });
      git(["init", "--quiet"]);
      git(["config", "core.autocrlf", "false"]);
      const attributes = new URL(".gitattributes", repository);
      if (existsSync(attributes)) writeFileSync(join(root, ".gitattributes"), readFileSync(attributes));
      for (const path of paths) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), readFileSync(new URL(path, repository)));
      }
      git(["add", "--all"]);
      git(["config", "core.autocrlf", "true"]);
      git(["checkout-index", "--all", "--prefix=checkout/"]);
      for (const path of paths) expect(readFileSync(join(root, "checkout", path))).toEqual(readFileSync(new URL(path, repository)));
    } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("[TC-PDDESKTOP-009] reproducible native checkout", () => {
  it("preserves embedded source, checksums and binary assets with Windows autocrlf", () => {
    verifyCheckout(process.env);
  });
  it("leaves the calling repository unchanged when a hook exports Git context", () => {
    const foreign = mkdtempSync(join(tmpdir(), "pdmux-foreign-git-"));
    try {
      const git = args => execFileSync("git", args, { cwd: foreign, stdio: "pipe", env: isolatedEnvironment(process.env) });
      git(["init", "--quiet"]);
      writeFileSync(join(foreign, "preserved.txt"), "preserve caller state\n");
      git(["add", "preserved.txt"]);
      const directory = join(foreign, ".git");
      const config = readFileSync(join(directory, "config"));
      const index = readFileSync(join(directory, "index"));
      verifyCheckout({ ...process.env, GIT_DIR: directory, GIT_COMMON_DIR: directory,
        GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(directory, "index"),
        GIT_OBJECT_DIRECTORY: join(directory, "objects"),
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" });
      expect(readFileSync(join(directory, "config"))).toEqual(config);
      expect(readFileSync(join(directory, "index"))).toEqual(index);
      expect(readFileSync(join(foreign, "preserved.txt"), "utf8")).toBe("preserve caller state\n");
    } finally { rmSync(foreign, { recursive: true, force: true }); }
  });
});
