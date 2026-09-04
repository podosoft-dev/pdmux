import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

export interface RuntimeLayout {
  bunExecutable: string;
  apiEntry: string;
  migrateEntry: string;
  webEntry: string;
  dataDirectory: string;
  filesDirectory: string;
  databasePath: string;
  secretPath: string;
  agentReleaseDirectory: string;
}

export interface RuntimeProcess {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): this;
}

export interface SpawnRuntimeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "inherit";
}

export type SpawnRuntime = (
  command: string,
  args: readonly string[],
  options: SpawnRuntimeOptions,
) => RuntimeProcess;

export interface StackDependencies {
  spawn: SpawnRuntime;
  allocatePort: () => Promise<number>;
  waitForUrl: (url: string) => Promise<void>;
}

export interface StackAddresses {
  apiUrl: string;
  webUrl: string;
}

const defaultDependencies: StackDependencies = {
  spawn: (command, args, options) => spawn(command, [...args], options),
  allocatePort: () => reserveLoopbackPort(),
  waitForUrl: (url) => waitForHealthyUrl(url),
};

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Cannot allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function waitForHealthyUrl(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Desktop runtime did not become ready: ${String(lastError)}`);
}

async function persistentSecret(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length < 32) throw new Error("Desktop authentication secret is invalid");
    return existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const value = randomBytes(32).toString("base64url");
  await writeFile(path, `${value}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return value;
}

function exited(child: RuntimeProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

interface NamedProcess {
  name: "api" | "web";
  process: RuntimeProcess;
}

export class StackManager {
  private readonly dependencies: StackDependencies;
  private children: NamedProcess[] = [];
  private stopping = false;
  private addresses?: StackAddresses;

  constructor(
    private readonly layout: RuntimeLayout,
    dependencies: Partial<StackDependencies> = {},
    private readonly onUnexpectedExit: (name: "api" | "web", code: number | null) => void = () => undefined,
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async start(): Promise<StackAddresses> {
    if (this.addresses) return this.addresses;
    this.stopping = false;
    await Promise.all([
      mkdir(this.layout.dataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.layout.filesDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const secret = await persistentSecret(this.layout.secretPath);
    const [apiPort, webPort] = await Promise.all([
      this.dependencies.allocatePort(),
      this.dependencies.allocatePort(),
    ]);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const webUrl = `http://127.0.0.1:${webPort}`;
    const common: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      PDMUX_DESKTOP: "1",
      PDMUX_DATABASE_PROVIDER: "sqlite",
      PDMUX_CACHE_PROVIDER: "memory",
      PDMUX_OBJECT_STORAGE_PROVIDER: "local",
      PDMUX_EVENTS_PROVIDER: "memory",
      PDMUX_JOBS_PROVIDER: "local",
      DATABASE_URL: `sqlite://${this.layout.databasePath}`,
      PDMUX_DATA_DIR: this.layout.dataDirectory,
      PDMUX_FILES_DIR: this.layout.filesDirectory,
      AGENT_RELEASE_DIR: this.layout.agentReleaseDirectory,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: apiUrl,
      CORS_ORIGIN: webUrl,
      HOST: "127.0.0.1",
    };

    const migration = this.dependencies.spawn(
      this.layout.bunExecutable,
      [this.layout.migrateEntry],
      { cwd: dirname(this.layout.apiEntry), env: common, stdio: "inherit" },
    );
    const migrationCode = await exited(migration);
    if (migrationCode !== 0) throw new Error(`Desktop database migration exited with code ${migrationCode}`);

    const api = this.dependencies.spawn(
      this.layout.bunExecutable,
      [this.layout.apiEntry],
      { cwd: dirname(this.layout.apiEntry), env: { ...common, PORT: String(apiPort) }, stdio: "inherit" },
    );
    const web = this.dependencies.spawn(
      this.layout.bunExecutable,
      [this.layout.webEntry],
      {
        cwd: dirname(this.layout.webEntry),
        env: {
          ...common,
          PORT: String(webPort),
          ORIGIN: webUrl,
          BACKEND_INTERNAL_URL: apiUrl,
        },
        stdio: "inherit",
      },
    );
    this.children = [{ name: "api", process: api }, { name: "web", process: web }];
    for (const child of this.children) {
      child.process.once("exit", (code) => {
        if (!this.stopping) this.onUnexpectedExit(child.name, code);
      });
    }
    try {
      await this.dependencies.waitForUrl(`${apiUrl}/health/ready`);
      await this.dependencies.waitForUrl(webUrl);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.addresses = { apiUrl, webUrl };
    return this.addresses;
  }

  async restart(): Promise<StackAddresses> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const children = [...this.children].reverse();
    this.children = [];
    this.addresses = undefined;
    for (const child of children) await this.terminate(child.process);
  }

  private async terminate(child: RuntimeProcess): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      exited(child),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
