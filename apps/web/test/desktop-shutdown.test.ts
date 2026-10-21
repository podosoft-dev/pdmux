import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const hook = new URL("../src/lib/server/app-hooks.ts", import.meta.url).href;

function shutdown(desktop: boolean) {
  return spawnSync(process.execPath, ["-e", `
    await import(${JSON.stringify(hook)});
    // Model a remaining background handle after adapter-bun finishes draining.
    setInterval(() => undefined, 1000);
    console.log("adapter drained");
    process.emit("sveltekit:shutdown", "SIGTERM");
    setTimeout(() => { console.log("still running"); process.exit(23); }, 50);
  `], {
    env: { ...process.env, PDMUX_DESKTOP_RUNTIME: desktop ? "1" : "0" },
    encoding: "utf8", timeout: 2_000,
  });
}

describe("[TC-PDDESKTOP-005] desktop web shutdown", () => {
  it("exits normally after the adapter drains despite remaining background handles", () => {
    const child = shutdown(true);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("adapter drained");
    expect(child.stdout).not.toContain("still running");
  });

  it("preserves the server's shutdown ownership outside the desktop runtime", () => {
    const child = shutdown(false);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(23);
    expect(child.stdout).toContain("still running");
  });
});
