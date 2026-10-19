import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Callers provide only their disposable fixture root. Do not follow symlinks or
// inspect the machine's default agent state or another application's processes.
export async function fixtureNativeEngines(root, executable) {
  const engines = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.some(entry => entry.isFile() && entry.name === "endpoint.json")) {
      let binary = executable;
      if (!binary) {
        const cache = join(directory, "engines");
        const versions = await readdir(cache, { withFileTypes: true }).catch(() => []);
        const version = versions.find(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
        if (version) binary = join(cache, version.name, `pdmux-agent${process.platform === "win32" ? ".exe" : ""}`);
      }
      if (binary) engines.push({ root: directory, executable: binary });
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== "engines") await visit(join(directory, entry.name));
  }
  await visit(root);
  return engines;
}

export function fixtureNativeSessions(engine) {
  return JSON.parse(execFileSync(engine.executable, ["session", "list", "--root", engine.root, "--json"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }));
}

export async function stopFixtureNativeSessions(root, executable) {
  for (const engine of await fixtureNativeEngines(root, executable)) {
    let sessions;
    try { sessions = fixtureNativeSessions(engine); } catch { continue; }
    for (const info of sessions) execFileSync(engine.executable, ["session", "terminate", info.id, "--root", engine.root], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    for (let attempt = 0; ; attempt++) {
      try { execFileSync(engine.executable, ["session", "stop", "--root", engine.root], { stdio: "ignore", windowsHide: true, timeout: 10_000 }); break; }
      catch (error) { if (attempt >= 99) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
  }
}
