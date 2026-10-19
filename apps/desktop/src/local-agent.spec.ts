import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgent } from "./local-agent.js";
import { desktopMessages } from "./i18n.js";
import type { RuntimeLayout } from "./stack-manager.js";

let root: string;
let agent: LocalAgent | undefined;
afterEach(async () => { await agent?.stop(); agent = undefined; if (root) await rm(root, { recursive: true, force: true }); });
const hostId = "cc37aebc-f39a-4147-b31b-fb907fe8f78e";
async function fixture(platform: NodeJS.Platform = process.platform): Promise<{
  run: () => Promise<void>; payload: () => Record<string, unknown>; setPayload: (value: Record<string, unknown>) => void;
  calls: Array<{ path: string; body?: object }>; spawned: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }>; directory: string;
  label: () => string; setLabel: (value: string) => void; setComputerName: (value: string) => void; otherLabels: string[]; legacyConfig: () => Promise<void>;
  failures: Set<"list" | "rename">; logs: Array<{ action: string; error: unknown; context?: Record<string, unknown> }>; config: () => Promise<Record<string, unknown>>;
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
  let payload: Record<string, unknown> = { slots: [] }; let created = false; let label = ""; let computerName = "Design workstation";
  const otherLabels: string[] = [];
  const failures = new Set<"list" | "rename">();
  const logs: Array<{ action: string; error: unknown; context?: Record<string, unknown> }> = [];
  const stack = {
    start: async () => ({ apiUrl:"http://127.0.0.1:10001", webUrl:"http://127.0.0.1:10002" }),
    localRequest: async (path: string, init?: RequestInit): Promise<Response> => {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, ...(body && typeof body === "object" ? { body } : {}) });
      if (path === "/hosts" && init?.method === "POST" && body && typeof body === "object" && "label" in body) { created = true; label = String(body.label); return Response.json({ id: hostId }); }
      if (path === "/hosts" && failures.has("list")) return Response.json({ success: false }, { status: 500 });
      if (path === "/hosts") return Response.json([...otherLabels.map(label => ({ id: crypto.randomUUID(), label })), ...(created ? [{ id: hostId, label }] : [])]);
      if (path === `/hosts/${hostId}/tokens`) return Response.json({ token: "private-agent-token" });
      if (path === `/hosts/${hostId}`) {
        if (init?.method === "PATCH" && failures.has("rename")) return Response.json({ success: false }, { status: 500 });
        if (init?.method === "PATCH" && body && typeof body === "object" && "label" in body) label = String(body.label);
        return Response.json({ id:hostId, label, connected:created });
      }
      if (path === "/prefs") return Response.json({ layouts:[{ name:"default", isDefault:true, payload }] });
      if (path === "/prefs/layouts/default" && body && typeof body === "object" && "payload" in body) { payload = body.payload as Record<string, unknown>; return Response.json({}); }
      throw new Error(`Unexpected path ${path}`);
    },
  };
  const launch: typeof spawn = ((executable: string, args: readonly string[], options: SpawnOptions) => {
    spawned.push({ executable, args, options });
    return spawn(process.execPath, ["-e", 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], options);
  }) as typeof spawn;
  agent = new LocalAgent(stack, layout, "local-profile", "This computer", { platform, computerName: async () => computerName, spawn: launch, log: (action, error, context) => { logs.push({ action, error, ...(context ? { context } : {}) }); }, environment:{ ...process.env, TMUX:"private-fixture", PDMUX_TOKEN:"inherited-token", PDMUX_SERVER:"https://invalid.test", PDMUX_RESTART:"service", INVOCATION_ID:"inherited-service" } });
  return { run: () => agent!.start(), payload:() => payload, setPayload:value => { payload = value; }, calls, spawned, directory,
    label: () => label, setLabel: value => { label = value; }, setComputerName: value => { computerName = value; }, otherLabels,
    legacyConfig: async () => {
      const profiles = join(root,"local-agent"); const path = join(profiles,(await readdir(profiles))[0]!,"agent.json");
      const config = JSON.parse(await readFile(path,"utf8")); delete config.computerNameApplied;
      await writeFile(path,JSON.stringify(config));
    },
    failures, logs,
    config: async () => { const profiles = join(root,"local-agent"); return JSON.parse(await readFile(join(profiles,(await readdir(profiles))[0]!,"agent.json"),"utf8")); },
  };
}

for (const platform of ["darwin", "win32", "linux"] as const) {
  it(`[TC-PDDESKTOP-017] names a new ${platform} host after the computer`, async () => {
    const state = await fixture(platform); await state.run();
    expect(agent?.status().phase).toBe("ready");
    expect(state.label()).toBe("Design workstation");
  });
}
for (const locale of ["en", "ko"]) {
  it(`[TC-PDDESKTOP-017] migrates the ${locale} default name without replacing its host or terminal`, async () => {
    const state = await fixture(); await state.run();
    state.setLabel(desktopMessages(locale).localHost); await state.legacyConfig();
    state.setPayload({ slots: [], mode:"split4" });
    await state.run();
    expect(agent?.status()).toEqual({ phase:"ready", hostId });
    expect(state.label()).toBe("Design workstation");
    expect(state.payload()).toEqual({ slots:[],mode:"split4" });
    expect(state.calls.filter(call => call.path === "/hosts" && call.body)).toHaveLength(1);
    expect(state.calls.filter(call => call.path.endsWith("/tokens"))).toHaveLength(1);
  });
}
it("[TC-PDDESKTOP-017] preserves custom names and applies the legacy name migration only once", async () => {
  const state = await fixture(); await state.run();
  state.setLabel("My development machine"); await state.legacyConfig(); await state.run();
  expect(agent?.status().phase).toBe("ready");
  expect(state.label()).toBe("My development machine");
  state.setLabel(desktopMessages("en").localHost); await state.run();
  expect(agent?.status().phase).toBe("ready");
  expect(state.label()).toBe(desktopMessages("en").localHost);
});
for (const failure of ["rename", "list"] as const) {
  it(`[TC-PDDESKTOP-017] starts the agent and keeps the old name when ${failure === "rename" ? "renaming the host" : "listing hosts"} fails`, async () => {
    const state = await fixture(); await state.run();
    state.setLabel(desktopMessages("en").localHost); await state.legacyConfig();
    state.failures.add(failure); await state.run();
    expect(agent?.status()).toEqual({ phase:"ready", hostId });
    expect(state.label()).toBe(desktopMessages("en").localHost);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.action).toBe("Rename the local desktop host");
    expect(JSON.stringify(state.logs)).not.toContain("private-agent-token");
    expect((await state.config()).computerNameApplied).not.toBe(true);
    state.failures.clear(); await state.run();
    expect(state.label()).toBe("Design workstation");
  });
}
it("[TC-PDDESKTOP-017] fits long computer names within the host limit and avoids existing labels", async () => {
  const state = await fixture(); const name = "W".repeat(80); state.setComputerName(` ${name} `);
  state.otherLabels.push(name.slice(0,64), `${name.slice(0,60)} (2)`);
  await state.run();
  expect(agent?.status().phase).toBe("ready");
  expect(state.label()).toBe(`${name.slice(0,60)} (3)`);
});

it("[TC-PDDESKTOP-017] prepares #1 once, reuses the host and preserves an intentionally cleared layout", async () => {
  const state = await fixture(); await state.run();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(state.payload().slots).toEqual([{ id:"slot-1",hostId,kind:"shell",session:null }]);
  state.setPayload({ slots: [], mode:"split4" });
  await state.run();
  expect(state.payload()).toEqual({ slots:[],mode:"split4" });
  expect(state.calls.filter(call => call.path === "/hosts" && call.body)).toHaveLength(1);
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
