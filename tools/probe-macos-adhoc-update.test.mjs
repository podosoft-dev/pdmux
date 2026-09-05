import { describe, expect, it } from "bun:test";
import { Script } from "node:vm";
import { designatedRequirement, fixtureManifest, fixtureSource, probeEnvironment } from "./probe-macos-adhoc-update.mjs";

describe("[TC-PDDESKTOP-009] native ad-hoc update preflight", () => {
  it("allows ad-hoc PR signing without passing certificate credentials", () => {
    const source = { PATH: "/bin", CSC_LINK: "fixture", APPLE_API_KEY: "fixture", WIN_CSC_LINK: "fixture", CSC_NAME: "fixture" };
    expect(probeEnvironment(source)).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_FOR_PULL_REQUEST: "true" });
    expect(source.CSC_LINK).toBe("fixture");
  });
  it("emits parseable relaunch events from the generated Electron entry point", async () => {
    let output = "";
    let quit = false;
    const app = {
      setPath: () => {}, whenReady: () => Promise.resolve(), getVersion: () => "0.0.2",
      quit: () => { quit = true; }, exit: () => { throw new Error("Unexpected fixture failure"); },
    };
    const fs = {
      appendFileSync: (_path, data) => { output += data; }, readFileSync: () => "preserve-me",
    };
    new Script(fixtureSource("0.0.2")).runInNewContext({
      process: { env: { PDMUX_PROBE_ROOT: "/tmp/probe" } },
      require: (name) => {
        if (name === "electron") return { app };
        if (name === "node:fs") return fs;
        if (name === "node:path") return { join: (...parts) => parts.join("/") };
        return { autoUpdater: {} };
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(output.trim().split("\n").map(line => JSON.parse(line).event)).toEqual(["ready", "updated"]);
    expect(quit).toBe(true);
  });
  it("preserves the exact old-app requirement including its code hash", () => {
    expect(designatedRequirement('Executable=/tmp/probe\ndesignated => cdhash H"1234"\n')).toBe('cdhash H"1234"');
    expect(designatedRequirement('# designated => cdhash H"abcd"\n')).toBe('cdhash H"abcd"');
    expect(() => designatedRequirement("no requirement")).toThrow("Missing designated requirement");
  });
  it("creates different disposable packages without changing product identity", () => {
    const first = fixtureManifest("0.0.1", "44.2.0", "/tmp/probe-a");
    const second = fixtureManifest("0.0.2", "44.2.0", "/tmp/probe-b");
    expect(first.version).not.toBe(second.version);
    expect(first.build.appId).toBe(second.build.appId);
    expect(first.build.appId).not.toBe("dev.podosoft.pdmux");
    expect(first.build.mac.identity).toBe("-");
    expect(first.build.mac.hardenedRuntime).toBe(true);
    expect(first.build.mac.notarize).toBe(false);
  });
});
