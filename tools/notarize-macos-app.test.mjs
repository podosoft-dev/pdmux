import { describe, it, expect } from "bun:test";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterSign, notarizeMacApp } from "./notarize-macos-app.mjs";
import { staplerWithRetry } from "./apple-signing.mjs";

const env = { APPLE_API_KEY: "/tmp/key.p8", APPLE_API_KEY_ID: "ABCDEFGHIJ", APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000" };
const receipt = JSON.stringify({ id: "11111111-2222-3333-4444-555555555555", status: "Accepted" });

describe("[TC-PDDESKTOP-009] app notarization staples with the release retry schedule", () => {
  it("submits an archive of the signed app, then staples and validates that app", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdmux-notarize-test-"));
    try {
      const calls = [];
      const command = (name, args) => { calls.push([name, ...args]); return name === "xcrun" ? receipt : ""; };
      const stapler = async (action, path) => { calls.push(["stapler", action, path]); };
      const result = await notarizeMacApp("/tmp/out/PDMux.app", env, { command, stapler, temporaryRoot: root, log: () => {} });
      expect(result.status).toBe("Accepted");
      expect(calls.map(call => call[0] === "stapler" ? call.join(" ") : call.slice(0, 3).join(" "))).toEqual([
        "ditto -c -k", "xcrun notarytool submit", "stapler staple /tmp/out/PDMux.app", "stapler validate /tmp/out/PDMux.app",
      ]);
      const submit = calls[1];
      expect(submit).toContain("--wait");
      expect(submit[submit.indexOf("--key") + 1]).toBe(env.APPLE_API_KEY);
      expect(calls[0].at(-2)).toBe("/tmp/out/PDMux.app");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses to staple an app Apple did not accept", async () => {
    let stapled = false;
    const command = name => name === "xcrun" ? JSON.stringify({ id: "11111111-2222-3333-4444-555555555555", status: "Invalid" }) : "";
    await expect(notarizeMacApp("/tmp/PDMux.app", env, { command, stapler: async () => { stapled = true; }, log: () => {} })).rejects.toThrow("did not accept");
    expect(stapled).toBe(false);
  });
  it("requires the notary API key in the packaging environment", async () => {
    await expect(notarizeMacApp("/tmp/PDMux.app", { ...env, APPLE_API_ISSUER: "" }, { command: () => receipt, stapler: async () => {} })).rejects.toThrow("APPLE_API_ISSUER");
  });
  it("retries a staple that loses Apple's CloudKit connection instead of failing the release", async () => {
    // The 0.17.10 Intel failure: stapler exit 68 with NSURLErrorDomain -1005.
    const results = [
      { status: 68, stderr: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' },
      { status: 68, stderr: "The staple and validate action failed! Error 68." },
      { status: 0, stderr: "" },
    ];
    const waits = [];
    await staplerWithRetry("staple", "/tmp/PDMux.app", env, { run: () => results.shift(), wait: async ms => { waits.push(ms); }, log: () => {} });
    expect(waits).toEqual([20_000, 30_000]);
  });
  it("runs only for macOS packages and finds the app by product name", async () => {
    const paths = [];
    const packager = { appInfo: { productFilename: "PDMux" } };
    await afterSign({ electronPlatformName: "win32", appOutDir: "/tmp/win", packager }, { notarize: async path => { paths.push(path); } });
    await afterSign({ electronPlatformName: "darwin", appOutDir: "/tmp/mac-x64", packager }, { notarize: async path => { paths.push(path); } });
    expect(paths).toEqual(["/tmp/mac-x64/PDMux.app"]);
  });
});
