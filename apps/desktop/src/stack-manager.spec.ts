import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StackManager,
  type RuntimeLayout,
  type RuntimeProcess,
  type SpawnRuntimeOptions,
} from "./stack-manager.js";

class FakeProcess implements RuntimeProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  onKill?: (signal: NodeJS.Signals) => void;
  private readonly listeners: Array<(code: number | null) => void> = [];

  constructor(
    readonly name: string,
    private readonly killed: string[],
    autoExit: number | null | undefined,
  ) {
    if (autoExit !== undefined) queueMicrotask(() => this.exit(autoExit));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(this.name);
    if (this.onKill) this.onKill(signal);
    else this.exit(0);
    return true;
  }

  once(_event: "exit", listener: (code: number | null) => void): this {
    if (this.exitCode !== null) queueMicrotask(() => listener(this.exitCode));
    else this.listeners.push(listener);
    return this;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of this.listeners.splice(0)) listener(code);
  }
}

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("[TC-PDDESKTOP-005] embedded stack lifecycle", () => {
  it("[TC-PDDESKTOP-021] migrates first, hides runtime consoles, and stops in reverse order", async () => {
    root = await mkdtemp(join(tmpdir(), "pdmux-stack-"));
    const layout: RuntimeLayout = {
      bunExecutable: "/runtime/bun",
      apiEntry: "/resources/api/main.js",
      migrateEntry: "/resources/api/desktop-migrate.js",
      webEntry: "/resources/web/index.js",
      dataDirectory: root,
      filesDirectory: join(root, "files"),
      databasePath: join(root, "pdmux.sqlite"),
      secretPath: join(root, "auth.secret"),
      agentReleaseDirectory: "/resources/web/client/agent",
    };
    const calls: Array<{ entry: string; args: readonly string[]; options: SpawnRuntimeOptions }> = [];
    const killed: string[] = [];
    const ports = [51002, 51003, 51001];
    const manager = new StackManager(layout, {
      allocatePort: () => Promise.resolve(ports.shift() ?? 0),
      waitForUrl: () => Promise.resolve(),
      startGateway: async (api, web, port) => {
        expect(api).toBe("http://127.0.0.1:51002");
        expect(web).toBe("http://127.0.0.1:51003");
        return { url: `http://127.0.0.1:${port}`, close: async () => { killed.push("gateway"); } };
      },
      spawn: (_command, args, options) => {
        const entry = args[args.length - 1] ?? "";
        calls.push({ entry, args, options });
        return new FakeProcess(entry, killed, entry.endsWith("migrate.js") ? 0 : undefined);
      },
    });

    await expect(manager.start()).resolves.toEqual({
      apiUrl: "http://127.0.0.1:51002",
      webUrl: "http://127.0.0.1:51001",
    });
    expect(calls.map((call) => call.entry)).toEqual([
      layout.migrateEntry,
      layout.apiEntry,
      layout.webEntry,
    ]);
    for (const call of calls) expect(call.options.windowsHide).toBe(true);
    for (const call of calls) expect(call.args).toEqual(["--no-install", call.entry]);
    expect(calls[1]?.options.env.HOST).toBe("127.0.0.1");
    expect(calls[1]?.options.env).toMatchObject({
      DATABASE_PROVIDER: "sqlite",
      CACHE_PROVIDER: "memory",
      OBJECT_STORAGE_PROVIDER: "local",
      EVENTS_PROVIDER: "memory",
      JOBS_PROVIDER: "local",
    });
    expect(calls[2]?.options.env.BACKEND_INTERNAL_URL).toBe("http://127.0.0.1:51002");
    expect(calls[2]?.options.env.PROTOCOL_HEADER).toBe("x-forwarded-proto");
    expect(calls[2]?.options.env.HOST_HEADER).toBe("x-forwarded-host");
    // Unset, Bun closes a silent request after 10 seconds: a transfer commit or an
    // MCP call before its first keep-alive.
    expect(calls[2]?.options.env.CONNECTION_IDLE_TIMEOUT).toBe("0");
    expect(calls[2]?.options.env.SHUTDOWN_TIMEOUT).toBe("0");
    expect(calls[1]?.options.env.SHUTDOWN_TIMEOUT).toBe(process.env.SHUTDOWN_TIMEOUT);
    expect(calls[1]?.options.env.CORS_ORIGIN).toBe("http://127.0.0.1:51001");
    if (process.platform !== "win32") {
      expect((await stat(layout.secretPath)).mode & 0o777).toBe(0o600);
    }

    await manager.stop();
    expect(killed).toEqual(["gateway", layout.webEntry, layout.apiEntry]);
  });
});

async function runningStack(): Promise<{ manager: StackManager; children: FakeProcess[]; killed: string[] }> {
  root = await mkdtemp(join(tmpdir(), "pdmux-stack-quit-"));
  const children: FakeProcess[] = [];
  const killed: string[] = [];
  const manager = new StackManager({
    bunExecutable: "/runtime/bun", apiEntry: "/api/main.js", migrateEntry: "/api/migrate.js",
    webEntry: "/web/index.js", dataDirectory: root, filesDirectory: join(root, "files"),
    databasePath: join(root, "pdmux.sqlite"), secretPath: join(root, "auth.secret"),
    agentReleaseDirectory: "/agent",
  }, {
    allocatePort: async () => 0,
    waitForUrl: async () => undefined,
    startGateway: async () => ({ url: "http://127.0.0.1", close: async () => { killed.push("gateway"); } }),
    spawn: (_command, args) => {
      const entry = args.at(-1)!;
      const child = new FakeProcess(entry, killed, entry.endsWith("migrate.js") ? 0 : undefined);
      if (!entry.endsWith("migrate.js")) children.push(child);
      return child;
    },
  });
  await manager.start();
  return { manager, children, killed };
}

describe("[TC-PDDESKTOP-005] prompt and complete shutdown", () => {
  it("signals both services without serial waits and joins repeated stop requests", async () => {
    const { manager, children, killed } = await runningStack();
    for (const child of children) child.onKill = () => undefined;
    let completed = false;
    const first = manager.stop().then(() => { completed = true; });
    const repeated = manager.stop().then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(killed).toEqual(["gateway", "/web/index.js", "/api/main.js"]);
      expect(completed).toBe(false);
      children[0]!.exit(0);
      await new Promise(resolve => setImmediate(resolve));
      expect(completed).toBe(false);
    } finally {
      for (const child of children) child.exit(0);
      await Promise.all([first, repeated]);
    }
    expect(completed).toBe(true);
  });

  it("does not wait for an exit event already delivered after signal termination", async () => {
    const { manager, children, killed } = await runningStack();
    children[1]!.exit(null, "SIGTERM");
    await manager.stop();
    expect(killed).toEqual(["gateway", "/api/main.js"]);
  }, 1_000);

  it("clears escalation after normal exit and awaits actual exit after force", async () => {
    const { manager, children, killed } = await runningStack();
    let forced!: () => void;
    const escalated = new Promise<void>(resolve => { forced = resolve; });
    children[1]!.onKill = signal => { if (signal === "SIGKILL") forced(); };
    let completed = false;
    const stopped = manager.stop().then(() => { completed = true; });
    await escalated;
    try {
      expect(killed.filter(name => name === "/api/main.js")).toHaveLength(1);
      expect(killed.filter(name => name === "/web/index.js")).toHaveLength(2);
      expect(completed).toBe(false);
    } finally {
      children[1]!.exit(null, "SIGKILL");
      await stopped;
    }
    expect(completed).toBe(true);
  }, 10_000);
});
