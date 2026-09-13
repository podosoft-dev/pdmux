import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";

describe("[TC-PDDESKTOP-009] reproducible native checkout", () => {
  it("preserves embedded source, checksums and binary assets with Windows autocrlf", () => {
    const root = mkdtempSync(join(tmpdir(), "pdmux-checkout-"));
    const repository = new URL("../", import.meta.url);
    const version = parseAgentVersion(readFileSync(new URL("agent/internal/cli/version.go", repository), "utf8"));
    const paths = ["agent/internal/protocol/schema/protocol.schema.json", "agent/internal/cli/version.go",
      `apps/web/static/agent/${version}/SHA256SUMS`, "apps/desktop/resources/tray.png"];
    try {
      const git = args => execFileSync("git", args, { cwd: root, stdio: "pipe" });
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
  });
});
