import { describe, expect, it } from "bun:test";
import { selectArtifact, windowsInstallArguments, verifyDesktopArtifacts } from "./verify-desktop-artifacts.mjs";

describe("[TC-PDDESKTOP-009] native artifact verification", () => {
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
