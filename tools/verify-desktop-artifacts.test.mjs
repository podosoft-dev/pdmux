import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linuxInstallationDirectory, selectArtifact, windowsInstallArguments, verifyDesktopArtifacts } from "./verify-desktop-artifacts.mjs";

describe("[TC-PDDESKTOP-009] native artifact verification", () => {
  it.skipIf(process.platform === "win32")("resolves the installed Linux command through alternatives after a display-name change", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "pdmux-linux-install-")));
    try {
      const installed = join(temporary, "opt", "PDMux");
      const command = join(temporary, "usr", "bin", "pdmux");
      const alternative = join(temporary, "etc", "alternatives", "pdmux");
      for (const directory of [installed, dirname(command), dirname(alternative)]) await mkdir(directory, { recursive: true });
      await writeFile(join(installed, "pdmux"), "installed executable");
      await symlink(join(installed, "pdmux"), alternative);
      await symlink(alternative, command);
      expect(await linuxInstallationDirectory(command)).toBe(installed);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  it("rejects missing or ambiguous installers before executing them", () => {
    expect(selectArtifact(["pdmux.exe", "pdmux.exe.blockmap"], ".exe")).toBe("pdmux.exe");
    expect(() => selectArtifact(["pdmux.exe.blockmap"], ".exe")).toThrow();
    expect(() => selectArtifact(["pdmux-a.exe", "pdmux-b.exe"], ".exe")).toThrow();
  });
  it("preserves an NSIS destination with spaces as the final unquoted argument", () => {
    expect(windowsInstallArguments("C:\\temporary directory\\pdmux")).toEqual([
      "/S", "/currentuser", "/D=C:\\temporary directory\\pdmux",
    ]);
    expect(() => windowsInstallArguments('C:\\app" /allusers')).toThrow();
    expect(() => windowsInstallArguments("C:\\app\n/S")).toThrow();
  });
  it("does not install packages outside a disposable hosted runner", async () => {
    if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted") return;
    await expect(verifyDesktopArtifacts("missing-directory")).rejects.toThrow(/disposable|self-hosted/);
  });
});
