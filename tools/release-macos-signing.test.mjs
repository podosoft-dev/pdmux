import { describe, it, expect } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { assertReleaseContext, assertCertificate } from "./release-macos-signing.mjs";

describe("[TC-PDDESKTOP-009] production signing boundary", () => {
  it("loads the backup probe through Node inspector-compatible evaluation", () => {
    const root = mkdtempSync(join(tmpdir(), "pdmux-inspector-test-"));
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(join(root, "dist/backup.js"), "export class BackupService {}");
      const source = readFileSync(new URL("./smoke-macos-desktop.mjs", import.meta.url), "utf8");
      const prefix = source.split("application.evaluate(")[1].split("    const data =")[0];
      const expression = `(${prefix}\nreturn typeof require("./dist/backup.js").BackupService;})({app:{getAppPath:()=>${JSON.stringify(root)}}})`;
      const script = `const {Script}=require("node:vm"); new Script(${JSON.stringify(expression)}).runInNewContext({process}).then(value=>console.log(value)).catch(error=>{console.error(error);process.exitCode=1;});`;
      const result = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 10_000 });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("function");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const valid = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.12.2", GITHUB_REF_NAME: "v0.12.2", GITHUB_REPOSITORY: "podosoft-dev/pdmux", PDMUX_SIGNING_SOURCE_REF: "v0.12.2" };
  it("accepts only the running release tag from this repository", () => {
    expect(() => assertReleaseContext(valid)).not.toThrow();
    for (const override of [
      { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_EVENT_NAME: "pull_request_target" }, { GITHUB_REF: "refs/heads/main" },
      { GITHUB_REPOSITORY: "example/fork" }, { PDMUX_SIGNING_SOURCE_REF: "main" },
    ]) expect(() => assertReleaseContext({ ...valid, ...override })).toThrow();
  });
  it("pins the checked-in public certificate and rejects malformed certificates", () => {
    const pem = readFileSync(new URL("../apps/desktop/signing-certificate.pem", import.meta.url));
    expect(assertCertificate(pem, pem).subject).toContain("pdmux Desktop Signing");
    expect(() => assertCertificate("not a certificate", pem)).toThrow();
    expect(() => assertCertificate(pem, rootCertificates[0])).toThrow("Unexpected signing certificate");
  });
});
