import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { defaultLayout } from "@pdmux/core";
import { compareVersionStrings } from "@pdmux/protocol";
import { z } from "zod";
import type { RuntimeLayout, StackManager } from "./stack-manager.js";

const configuration = z.object({ hostId: z.string().uuid(), token: z.string().default(""), server: z.string(), hostname: z.string(), layoutPrepared: z.boolean().default(false) });
type Configuration = z.infer<typeof configuration>;
export interface LocalAgentStatus { phase: "starting" | "ready" | "failed" | "stopped"; hostId?: string; code?: string }
export interface LocalAgentDependencies { spawn: typeof spawn; platform: NodeJS.Platform; arch: string; environment: NodeJS.ProcessEnv }

/** The embedded agent belongs to the desktop runtime, not a standalone host
 * installation. A lifetime pipe closes it if Electron exits, and this supervisor
 * restarts only its own process. Existing system/user agents are never touched. */
export class LocalAgent {
  private child?: ChildProcess;
  private stopping = false;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private current: LocalAgentStatus = { phase: "stopped" };
  private readonly directory: string;
  private readonly configPath: string;
  private readonly dependencies: LocalAgentDependencies;
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly stack: Pick<StackManager, "start" | "localRequest">, private readonly layout: RuntimeLayout, profileId: string, private readonly label: string, dependencies: Partial<LocalAgentDependencies> = {}) {
    this.dependencies = { spawn, platform: process.platform, arch: process.arch, environment: process.env, ...dependencies };
    this.directory = join(layout.dataDirectory, "local-agent", createHash("sha256").update(profileId).digest("hex").slice(0, 24));
    this.configPath = join(this.directory, "agent.json");
  }

  status(): LocalAgentStatus { return { ...this.current }; }
  start(refreshToken = false): Promise<void> {
    this.serial = this.serial.then(async () => {
      await this.stop(); this.stopping = false; this.current = { phase: "starting" };
      try { await this.prepare(refreshToken); }
      catch { this.current = { ...this.current, phase: "failed", code: "DESKTOP_LOCAL_AGENT_FAILED" }; await this.stopChild(); }
    });
    return this.serial;
  }

  private async request<T>(path: string, method = "GET", body?: object): Promise<T> {
    const response = await this.stack.localRequest(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Local agent setup failed (${response.status})`);
    return await response.json() as T;
  }

  private async save(config: Configuration): Promise<void> {
    await writeFile(this.configPath, JSON.stringify(config), { mode: 0o600 });
    await chmod(this.configPath, 0o600);
  }

  private async binary(): Promise<string> {
    const versions = (await readdir(this.layout.agentReleaseDirectory)).filter(value => /^\d+\.\d+\.\d+$/.test(value)).sort((a, b) => compareVersionStrings(b, a) ?? 0);
    const directory = join(this.layout.agentReleaseDirectory, versions[0] ?? "missing");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { artifacts: Array<{ os: string; arch: string; path: string; bytes: number; sha256: string }> };
    const { platform, arch } = this.dependencies;
    const target = manifest.artifacts.find(entry => entry.os === (platform === "win32" ? "windows" : platform) && entry.arch === (arch === "x64" ? "amd64" : arch));
    if (!target) throw new Error("The native agent is missing");
    const source = join(directory, target.path.split("/").at(-1) ?? "missing");
    const bytes = await readFile(source);
    if (bytes.length !== target.bytes || createHash("sha256").update(bytes).digest("hex") !== target.sha256) throw new Error("The native agent checksum is invalid");
    const destination = join(this.directory, platform === "win32" ? "pdmux-agent.exe" : "pdmux-agent");
    let matches = false;
    try { matches = createHash("sha256").update(await readFile(destination)).digest("hex") === target.sha256; } catch { /* First launch has no installed copy. */ }
    if (!matches) { await writeFile(`${destination}.tmp`, bytes, { mode: 0o700 }); await chmod(`${destination}.tmp`, 0o700); await rename(`${destination}.tmp`, destination); }
    return destination;
  }

  private async prepare(refreshToken: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const executable = await this.binary();
    const { webUrl } = await this.stack.start();
    let config: Configuration | undefined;
    try { config = configuration.parse(JSON.parse(await readFile(this.configPath, "utf8"))); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (config) {
      const existing = await this.stack.localRequest(`/hosts/${config.hostId}`);
      if (existing.status === 404) config = undefined;
      else if (!existing.ok) throw new Error("Cannot read the local host");
    }
    if (!config) {
      const host = await this.request<{ id: string }>("/hosts", "POST", { label: this.label });
      config = { hostId: host.id, token: "", server: webUrl, hostname: hostname(), layoutPrepared: false };
      await this.save(config);
    }
    config.server = webUrl;
    if (refreshToken) config.token = "";
    if (!config.token) {
      const issued = await this.request<{ token: string }>(`/hosts/${config.hostId}/tokens`, "POST", { name: "Desktop runtime" });
      config.token = issued.token;
    }
    await this.save(config);
    this.current = { phase: "starting", hostId: config.hostId };
    this.launch(executable);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (this.stopping || this.current.phase === "failed") throw new Error("The local agent stopped");
      const host = await this.request<{ connected: boolean }>(`/hosts/${config.hostId}`);
      if (host.connected) {
        await this.seedLayout(config);
        this.current = { phase: "ready", hostId: config.hostId }; this.attempts = 0; return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("The local agent did not connect");
  }

  private launch(executable: string): void {
    const environment = { ...this.dependencies.environment };
    for (const name of ["TMUX", "PDMUX_TOKEN", "PDMUX_SERVER", "PDMUX_CONFIG", "PDMUX_STATE_DIR", "PDMUX_HOSTNAME", "PDMUX_LOG_LEVEL"]) delete environment[name];
    const child = this.dependencies.spawn(executable, ["run", "--config", this.configPath, "--log-level", "warn"], {
      cwd: this.directory, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
      env: { ...environment, SHELL: environment.SHELL || userInfo().shell || "", PDMUX_STATE_DIR: join(this.directory, "state"), PDMUX_DESKTOP_AGENT: "1", PDMUX_RESTART: "none" },
    });
    this.child = child;
    child.once("error", () => { this.current = { ...this.current, phase: "failed", code: "DESKTOP_LOCAL_AGENT_FAILED" }; });
    child.once("exit", () => {
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      this.current = { ...this.current, phase: "failed", code: "DESKTOP_LOCAL_AGENT_EXITED" };
      if (this.attempts++ < 3) this.retry = setTimeout(() => { void this.start(); }, 1_000 * 2 ** this.attempts);
    });
  }

  private async seedLayout(config: Configuration): Promise<void> {
    if (config.layoutPrepared) return;
    const prefs = await this.request<{ layouts: Array<{ name: string; isDefault: boolean; payload: Record<string, unknown> }> }>("/prefs");
    const existing = prefs.layouts.find(row => row.isDefault) ?? prefs.layouts.find(row => row.name === "default");
    const slots = existing?.payload.slots;
    if (!Array.isArray(slots) || slots.every(slot => !slot)) {
      await this.request(`/prefs/layouts/${encodeURIComponent(existing?.name ?? "default")}`, "PUT", {
        isDefault: true,
        payload: { ...defaultLayout(), ...existing?.payload, slots: [{ id: "slot-1", hostId: config.hostId, kind: "shell", session: null }, ...(Array.isArray(slots) ? slots.slice(1) : [])], focusId: "slot-1" },
      });
    }
    config.layoutPrepared = true; await this.save(config);
  }

  private async stopChild(): Promise<void> {
    const child = this.child; this.child = undefined;
    if (!child || !child.pid || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const graceful = setTimeout(() => child.kill("SIGTERM"), 1_500);
      const forced = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("exit", () => { clearTimeout(graceful); clearTimeout(forced); resolve(); });
      child.stdin?.end();
    });
  }
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.retry); this.retry = undefined;
    await this.stopChild(); this.current = { ...this.current, phase: "stopped" };
  }
}
