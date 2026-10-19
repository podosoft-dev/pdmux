import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgent } from "./local-agent.js";
import { desktopMessages } from "./i18n.js";
import type { RuntimeLayout } from "./stack-manager.js";

let root: string;
let agent: LocalAgent | undefined;
afterEach(async () => { await agent?.stop(); agent = undefined; if (root) await rm(root, { recursive: true, force: true }); });
const hostId = "cc37aebc-f39a-4147-b31b-fb907fe8f78e";
const profileTag = createHash("sha256").update("local-profile").digest("hex").slice(0, 4).toUpperCase();
const defaultLabel = (platform: NodeJS.Platform = process.platform): string => `${platform === "darwin" ? "Mac" : platform === "win32" ? "Windows" : "Linux"} ${profileTag}`;
interface TokenRow { id: string; name: string; token: string; revokedAt: string | null; expiresAt: string | null }
async function fixture(platform: NodeJS.Platform = process.platform): Promise<{
  run: () => Promise<void>; retry: () => Promise<void>; tokens: TokenRow[]; payload: () => Record<string, unknown>; setPayload: (value: Record<string, unknown>) => void;
  calls: Array<{ method: string; path: string; body?: object }>; spawned: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }>; directory: string;
  label: () => string; setLabel: (value: string) => void; setComputerName: (value: string) => void; computerNameReads: () => number; otherLabels: string[]; legacyConfig: (fields?: Record<string, unknown>) => Promise<void>;
  failures: Set<"list" | "rename" | "revoke">; logs: Array<{ action: string; error: unknown; context?: Record<string, unknown> }>; config: () => Promise<Record<string, unknown>>;
}> {
  root = await mkdtemp(join(tmpdir(), "pdmux-local-agent-"));
  const releases = join(root, "agents"); const directory = join(releases, "0.1.28"); await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("verified native agent");
  const name = `pdmux-agent-${platform === "win32" ? "windows" : platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  await writeFile(join(directory, name), bytes);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ artifacts: [{ os: platform === "win32" ? "windows" : platform, arch: process.arch === "x64" ? "amd64" : process.arch, path: `/agent/0.1.28/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
  const layout: RuntimeLayout = { bunExecutable: process.execPath, apiEntry:"unused", migrateEntry:"unused", webEntry:"unused", dataDirectory: root, filesDirectory: join(root,"files"), databasePath:join(root,"db"),secretPath:join(root,"secret"),agentReleaseDirectory:releases };
  const calls: Array<{ method: string; path: string; body?: object }> = [];
  const spawned: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }> = [];
  let payload: Record<string, unknown> = { slots: [] }; let created = false; let label = ""; let computerName = "Design workstation"; let computerNameReads = 0;
  const otherLabels: string[] = [];
  const failures = new Set<"list" | "rename" | "revoke">();
  const tokens: TokenRow[] = [];
  const view = (row: TokenRow): Omit<TokenRow, "token"> => ({ id: row.id, name: row.name, revokedAt: row.revokedAt, expiresAt: row.expiresAt });
  const logs: Array<{ action: string; error: unknown; context?: Record<string, unknown> }> = [];
  const stack = {
    start: async () => ({ apiUrl:"http://127.0.0.1:10001", webUrl:"http://127.0.0.1:10002" }),
    localRequest: async (path: string, init?: RequestInit): Promise<Response> => {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const method = init?.method ?? "GET";
      calls.push({ method, path, ...(body && typeof body === "object" ? { body } : {}) });
      if (path === "/hosts" && init?.method === "POST" && body && typeof body === "object" && "label" in body) { created = true; label = String(body.label); return Response.json({ id: hostId }); }
      if (path === "/hosts" && failures.has("list")) return Response.json({ success: false }, { status: 500 });
      if (path === "/hosts") return Response.json([...otherLabels.map(label => ({ id: crypto.randomUUID(), label })), ...(created ? [{ id: hostId, label }] : [])]);
      if (path === `/hosts/${hostId}/tokens` && method === "GET") return Response.json(tokens.map(view));
      if (path === `/hosts/${hostId}/tokens` && method === "POST" && body && typeof body === "object" && "name" in body) {
        const row = { id: crypto.randomUUID(), name: String(body.name), token: `private-agent-token-${tokens.length + 1}`, revokedAt: null, expiresAt: null };
        tokens.push(row); return Response.json({ ...view(row), token: row.token }, { status: 201 });
      }
      const revoked = tokens.find(row => path === `/hosts/${hostId}/tokens/${row.id}` && method === "DELETE");
      if (revoked && failures.has("revoke")) return Response.json({ success: false }, { status: 500 });
      if (revoked) { revoked.revokedAt ??= new Date().toISOString(); return Response.json(view(revoked)); }
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
  agent = new LocalAgent(stack, layout, "local-profile", { platform, legacyComputerName: async () => { computerNameReads += 1; return computerName; }, spawn: launch, log: (action, error, context) => { logs.push({ action, error, ...(context ? { context } : {}) }); }, environment:{ ...process.env, TMUX:"private-fixture", PDMUX_TOKEN:"inherited-token", PDMUX_SERVER:"https://invalid.test", PDMUX_RESTART:"service", INVOCATION_ID:"inherited-service", NO_COLOR:"1", FORCE_COLOR:"0", TERM:"dumb", TERM_PROGRAM:"WarpTerminal", COLORTERM:"", CLICOLOR:"1", CODEX_CI:"1", CODEX_THREAD_ID:"parent-task", CLAUDECODE:"1", CODEX_HOME:"/fixture/codex-home" } });
  return { run: () => agent!.start(), retry: () => agent!.start(true), tokens, payload:() => payload, setPayload:value => { payload = value; }, calls, spawned, directory,
    label: () => label, setLabel: value => { label = value; }, setComputerName: value => { computerName = value; }, computerNameReads: () => computerNameReads, otherLabels,
    legacyConfig: async (fields = {}) => {
      const profiles = join(root,"local-agent"); const path = join(profiles,(await readdir(profiles))[0]!,"agent.json");
      const config = JSON.parse(await readFile(path,"utf8")); delete config.computerNameApplied; delete config.defaultLabelVersion;
      await writeFile(path,JSON.stringify({ ...config, ...fields }));
    },
    failures, logs,
    config: async () => { const profiles = join(root,"local-agent"); return JSON.parse(await readFile(join(profiles,(await readdir(profiles))[0]!,"agent.json"),"utf8")); },
  };
}

for (const platform of ["darwin", "win32", "linux"] as const) {
  it(`[TC-PDDESKTOP-017] names a new ${platform} host after the platform and profile, not the computer`, async () => {
    const state = await fixture(platform); await state.run();
    expect(agent?.status().phase).toBe("ready");
    expect(state.label()).toBe(defaultLabel(platform));
    expect(state.label()).toMatch(/^(Mac|Windows|Linux) [0-9A-F]{4}$/);
    expect(state.label()).not.toContain("Design workstation"); expect(state.label()).not.toContain(hostname());
    expect(state.computerNameReads()).toBe(0);
    expect((await state.config()).defaultLabelVersion).toBe(2);
  });
}
it("[TC-PDDESKTOP-017] avoids labels other hosts already use", async () => {
  const state = await fixture(); state.otherLabels.push(defaultLabel(), `${defaultLabel()} (2)`);
  await state.run();
  expect(agent?.status().phase).toBe("ready");
  expect(state.label()).toBe(`${defaultLabel()} (3)`);
});
for (const locale of ["en", "ko"]) {
  it(`[TC-PDDESKTOP-017] migrates the ${locale} default name without replacing its host or terminal`, async () => {
    const state = await fixture(); await state.run();
    state.setLabel(desktopMessages(locale).localHost); await state.legacyConfig();
    state.setPayload({ slots: [], mode:"split4" });
    await state.run();
    expect(agent?.status()).toEqual({ phase:"ready", hostId });
    expect(state.label()).toBe(defaultLabel());
    expect(state.payload()).toEqual({ slots:[],mode:"split4" });
    expect(state.calls.filter(call => call.path === "/hosts" && call.body)).toHaveLength(1);
    expect(state.calls.filter(call => call.path.endsWith("/tokens"))).toHaveLength(1);
  });
}
for (const label of ["Design workstation", "Design workstation (2)"]) {
  it(`[TC-PDDESKTOP-017] migrates the 0.17.5 computer name "${label}" once`, async () => {
    const state = await fixture(); await state.run();
    state.setLabel(label); await state.legacyConfig({ computerNameApplied: true }); await state.run();
    expect(agent?.status()).toEqual({ phase:"ready", hostId });
    expect(state.label()).toBe(defaultLabel());
    expect((await state.config()).defaultLabelVersion).toBe(2);
    expect(state.calls.filter(call => call.path === `/hosts/${hostId}` && call.body)).toEqual([{ method:"PATCH", path:`/hosts/${hostId}`, body:{ label:defaultLabel() } }]);
  });
}
it("[TC-PDDESKTOP-017] recognizes a long 0.17.5 computer name cut to the host limit with its suffix", async () => {
  const state = await fixture(); await state.run();
  const name = "W".repeat(80); state.setComputerName(` ${name} `);
  state.setLabel(`${name.slice(0,60)} (3)`); await state.legacyConfig({ computerNameApplied: true }); await state.run();
  expect(state.label()).toBe(defaultLabel());
});
for (const custom of ["My development machine", "Design workstation (1)", "Design workstation 2", "Design workstation laptop"]) {
  it(`[TC-PDDESKTOP-017] preserves the custom name "${custom}" and checks names only once`, async () => {
    const state = await fixture(); await state.run();
    state.setLabel(custom); await state.legacyConfig({ computerNameApplied: true }); await state.run();
    expect(agent?.status().phase).toBe("ready");
    expect(state.label()).toBe(custom);
    expect((await state.config()).defaultLabelVersion).toBe(2);
    state.setLabel("Design workstation"); await state.run();
    expect(agent?.status().phase).toBe("ready");
    expect(state.label()).toBe("Design workstation");
    expect(state.computerNameReads()).toBe(1);
  });
}
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
    expect((await state.config()).defaultLabelVersion).not.toBe(2);
    state.failures.clear(); await state.run();
    expect(state.label()).toBe(defaultLabel());
  });
}

it("[TC-PDDESKTOP-017] prepares #1 once, reuses the host and preserves an intentionally cleared layout", async () => {
  const state = await fixture(); await state.run();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(state.payload().slots).toEqual([{ id:"slot-1",hostId,kind:"new",session:"main",backend:"native",intent:"ensure" }]);
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
  expect(JSON.parse(await readFile(config,"utf8")).token).toBe("private-agent-token-1");
  if (process.platform !== "win32") expect((await stat(config)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(profiles,(await readdir(profiles))[0]!))).not.toContain("agent.json.tmp");
});
const minted = (state: Awaited<ReturnType<typeof fixture>>): number => state.calls.filter(call => call.method === "POST" && call.path === `/hosts/${hostId}/tokens`).length;
const revocations = (state: Awaited<ReturnType<typeof fixture>>): string[] => state.calls.filter(call => call.method === "DELETE").map(call => call.path.split("/").at(-1)!);
it("[TC-PDDESKTOP-023] reuses a live agent token on repeated retries", async () => {
  const state = await fixture(); await state.run();
  for (let attempt = 0; attempt < 3; attempt += 1) await state.retry();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(minted(state)).toBe(1); expect(revocations(state)).toEqual([]);
  expect(state.tokens.map(row => row.revokedAt)).toEqual([null]);
  expect(await state.config()).toMatchObject({ token:"private-agent-token-1", tokenId:state.tokens[0]!.id });
  expect(JSON.stringify(state.spawned.map(child => child.args))).not.toContain("private-agent-token");
});
it("[TC-PDDESKTOP-023] replaces a revoked agent token once", async () => {
  const state = await fixture(); await state.run();
  state.tokens[0]!.revokedAt = new Date().toISOString();
  await state.retry(); await state.retry();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(minted(state)).toBe(2); expect(revocations(state)).toEqual([]);
  expect(state.tokens.map(row => Boolean(row.revokedAt))).toEqual([true, false]);
  expect(await state.config()).toMatchObject({ token:"private-agent-token-2", tokenId:state.tokens[1]!.id });
});
it("[TC-PDDESKTOP-023] replaces an expired agent token and revokes it", async () => {
  const state = await fixture(); await state.run();
  state.tokens[0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await state.retry();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(minted(state)).toBe(2); expect(revocations(state)).toEqual([state.tokens[0]!.id]);
  expect(state.tokens.map(row => Boolean(row.revokedAt))).toEqual([true, false]);
});
it("[TC-PDDESKTOP-023] revokes stale desktop tokens of a config without a token ID", async () => {
  const state = await fixture(); await state.run();
  const stale = [{ id: crypto.randomUUID(), name: "Desktop runtime", token: "stale-1", revokedAt: null, expiresAt: null }, { id: crypto.randomUUID(), name: "Desktop runtime", token: "stale-2", revokedAt: null, expiresAt: null }];
  const other = { id: crypto.randomUUID(), name: "Build runner", token: "other", revokedAt: null, expiresAt: null };
  const revoked = { id: crypto.randomUUID(), name: "Desktop runtime", token: "old", revokedAt: new Date(0).toISOString(), expiresAt: null };
  state.tokens.push(...stale, other, revoked);
  await state.legacyConfig({ defaultLabelVersion: 2, tokenId: undefined });
  await state.retry();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  const current = state.tokens.at(-1)!;
  expect(minted(state)).toBe(2);
  expect(revocations(state).sort()).toEqual([state.tokens[0]!.id, ...stale.map(row => row.id)].sort());
  expect(other.revokedAt).toBeNull(); expect(current.revokedAt).toBeNull();
  expect(await state.config()).toMatchObject({ token:current.token, tokenId:current.id });
  await state.retry();
  expect(minted(state)).toBe(2);
});
it("[TC-PDDESKTOP-023] starts with the new token when revoking the old one fails", async () => {
  const state = await fixture(); await state.run();
  state.tokens[0]!.expiresAt = new Date(Date.now() - 1_000).toISOString(); state.failures.add("revoke");
  await state.retry();
  expect(agent?.status()).toEqual({ phase:"ready", hostId });
  expect(await state.config()).toMatchObject({ token:"private-agent-token-2", tokenId:state.tokens[1]!.id });
  expect(state.logs.map(entry => entry.action)).toEqual(["Revoke the replaced desktop agent token"]);
  expect(JSON.stringify(state.logs)).not.toContain("private-agent-token");
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

it("[TC-PDDESKTOP-017] gives desktop terminals their own color capabilities", async () => {
  const state = await fixture(); await state.run();
  const environment = state.spawned[0]?.options.env;
  expect(environment?.NO_COLOR).toBeUndefined();
  expect(environment?.FORCE_COLOR).toBeUndefined();
  expect(environment?.CLICOLOR).toBeUndefined();
  expect(environment?.CODEX_CI).toBeUndefined();
  expect(environment?.CODEX_THREAD_ID).toBeUndefined();
  expect(environment?.CLAUDECODE).toBeUndefined();
  expect(environment?.CODEX_HOME).toBe("/fixture/codex-home");
  expect(environment?.TERM).toBe("xterm-256color");
  expect(environment?.COLORTERM).toBe("truecolor");
  expect(environment?.TERM_PROGRAM).toBe("PDMux");
});
