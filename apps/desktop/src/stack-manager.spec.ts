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
  private readonly listeners: Array<(code: number | null) => void> = [];

  constructor(
    readonly name: string,
    private readonly killed: string[],
    autoExit: number | null | undefined,
  ) {
    if (autoExit !== undefined) queueMicrotask(() => this.exit(autoExit));
  }

  kill(): boolean {
    this.killed.push(this.name);
    this.exit(0);
    return true;
  }

  once(_event: "exit", listener: (code: number | null) => void): this {
    if (this.exitCode !== null) queueMicrotask(() => listener(this.exitCode));
    else this.listeners.push(listener);
    return this;
  }

  private exit(code: number | null): void {
    this.exitCode = code;
    for (const listener of this.listeners.splice(0)) listener(code);
  }
}

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("[TC-PDDESKTOP-005] embedded stack lifecycle", () => {
  it("migrates first, binds loopback services, and stops them in reverse order", async () => {
    root = await mkdtemp(join(tmpdir(), "pdmux-stack-"));
    const layout: RuntimeLayout = {
      bunExecutable: "/runtime/bun",
      apiEntry: "/resources/api/main.js",
      migrateEntry: "/resources/api/migrate.js",
      webEntry: "/resources/web/index.js",
      dataDirectory: root,
      filesDirectory: join(root, "files"),
      databasePath: join(root, "pdmux.sqlite"),
      secretPath: join(root, "auth.secret"),
      agentReleaseDirectory: "/resources/web/client/agent",
    };
    const calls: Array<{ entry: string; options: SpawnRuntimeOptions }> = [];
    const killed: string[] = [];
    const ports = [51002, 51001];
    const manager = new StackManager(layout, {
      allocatePort: () => Promise.resolve(ports.shift() ?? 0),
      waitForUrl: () => Promise.resolve(),
      spawn: (_command, args, options) => {
        const entry = args[0] ?? "";
        calls.push({ entry, options });
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
    expect(calls[1]?.options.env.HOST).toBe("127.0.0.1");
    expect(calls[1]?.options.env.PDMUX_JOBS_PROVIDER).toBe("local");
    expect(calls[2]?.options.env.BACKEND_INTERNAL_URL).toBe("http://127.0.0.1:51002");
    if (process.platform !== "win32") {
      expect((await stat(layout.secretPath)).mode & 0o777).toBe(0o600);
    }

    await manager.stop();
    expect(killed).toEqual([layout.webEntry, layout.apiEntry]);
  });
});
