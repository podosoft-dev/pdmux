import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgent } from "./local-agent.js";
import type { RuntimeLayout } from "./stack-manager.js";

let root: string;
let agent: LocalAgent | undefined;
afterEach(async () => { await agent?.stop(); agent = undefined; if (root) await rm(root, { recursive: true, force: true }); });
const hostId = "cc37aebc-f39a-4147-b31b-fb907fe8f78e";
async function fixture(platform: NodeJS.Platform = process.platform): Promise<{
  run: () => Promise<void>; payload: () => Record<string, unknown>; setPayload: (value: Record<string, unknown>) => void;
  calls: Array<{ path: string; body?: object }>; spawned: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }>; directory: string;
}> {
  root = await mkdtemp(join(tmpdir(), "pdmux-local-agent-"));
  const releases = join(root, "agents"); const directory = join(releases, "0.1.28"); await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("verified native agent");
  const name = `pdmux-agent-${platform === "win32" ? "windows" : platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  await writeFile(join(directory, name), bytes);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ artifacts: [{ os: platform === "win32" ? "windows" : platform, arch: process.arch === "x64" ? "amd64" : process.arch, path: `/agent/0.1.28/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
  const layout: RuntimeLayout = { bunExecutable: process.execPath, apiEntry:"unused", migrateEntry:"unused", webEntry:"unused", dataDirectory: root, filesDirectory: join(root,"files"), databasePath:join(root,"db"),secretPath:join(root,"secret"),agentReleaseDirectory:releases };
  const calls: Array<{ path: string; body?: object }> = [];
  const spawned: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }> = [];
  let payload: Record<string, unknown> = { slots: [] }; let created = false;
  const stack = {
    start: async () => ({ apiUrl:"http://127.0.0.1:10001", webUrl:"http://127.0.0.1:10002" }),
    localRequest: async (path: string, init?: RequestInit): Promise<Response> => {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, ...(body && typeof body === "object" ? { body } : {}) });
      if (path === "/hosts" && init?.method === "POST") { created = true; return Response.json({ id: hostId }); }
      if (path === `/hosts/${hostId}/tokens`) return Response.json({ token: "private-agent-token" });
      if (path === `/hosts/${hostId}`) return Response.json({ id:hostId, connected:created });
      if (path === "/prefs") return Response.json({ layouts:[{ name:"default", isDefault:true, payload }] });
      if (path === "/prefs/layouts/default" && body && typeof body === "object" && "payload" in body) { payload = body.payload as Record<string, unknown>; return Response.json({}); }
      throw new Error(`Unexpected path ${path}`);
    },
  };
  const launch: typeof spawn = ((executable: string, args: readonly string[], options: SpawnOptions) => {
    spawned.push({ executable, args, options });
    return spawn(process.execPath, ["-e", 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], options);
  }) as typeof spawn;
  agent = new LocalAgent(stack, layout, "local-profile", "This computer", { platform, spawn: launch, environment:{ ...process.env, TMUX:"private-fixture", PDMUX_TOKEN:"inherited-token", PDMUX_SERVER:"https://invalid.test", PDMUX_RESTART:"service", INVOCATION_ID:"inherited-service" } });
  return { run: () => agent!.start(), payload:() => payload, setPayload:value => { payload = value; }, calls, spawned, directory };
}

it("[TC-PDDESKTOP-017] prepares #1 once, reuses the host and preserves an intentionally cleared layout", async () => {
  const state = await fixture(); await state.run();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(state.payload().slots).toEqual([{ id:"slot-1",hostId,kind:"shell",session:null }]);
  state.setPayload({ slots: [], mode:"split4" });
  await state.run();
  expect(state.payload()).toEqual({ slots:[],mode:"split4" });
  expect(state.calls.filter(call => call.path === "/hosts")).toHaveLength(1);
  expect(state.calls.filter(call => call.path.endsWith("/tokens"))).toHaveLength(1);
  const child = state.spawned[0]!;
  expect(JSON.stringify(child.args)).not.toContain("private-agent-token");
  expect(child.options.env?.PDMUX_TOKEN).toBeUndefined();
  expect(child.options.env?.TMUX).toBeUndefined();
  expect(child.options.env?.PDMUX_RESTART).toBe("none");
  const profiles = join(root,"local-agent"); const config = join(profiles,(await readdir(profiles))[0]!,"agent.json");
  expect(JSON.parse(await readFile(config,"utf8")).token).toBe("private-agent-token");
  if (process.platform !== "win32") expect((await stat(config)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(profiles,(await readdir(profiles))[0]!))).not.toContain("agent.json.tmp");
});
it("[TC-PDDESKTOP-017] preserves an existing layout on first preparation", async () => {
  const state = await fixture(); const existing = { slots:[{id:"existing",hostId,kind:"shell",session:null}],mode:"split2" };
  state.setPayload(existing); await state.run(); expect(state.payload()).toEqual(existing);
});
it("[TC-PDDESKTOP-017] refuses modified native bytes before creating a host", async () => {
  const state = await fixture(); const binary = (await readdir(state.directory)).find(name => name.startsWith("pdmux-agent-"))!;
  await writeFile(join(state.directory,binary),"tampered"); await state.run();
  expect(agent?.status().phase).toBe("failed"); expect(state.calls).toHaveLength(0); expect(state.spawned).toHaveLength(0);
});
it("[TC-PDDESKTOP-018] stages Windows as an executable and uses the same lifetime pipe", async () => {
  const state = await fixture("win32"); await state.run();
  expect(agent?.status().phase).toBe("ready");
  expect(state.spawned[0]?.executable.endsWith("pdmux-agent.exe")).toBe(true);
  expect(state.spawned[0]?.options.env?.PDMUX_DESKTOP_AGENT).toBe("1");
});
