import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { startDesktopGateway, type DesktopGateway } from "./gateway.js";

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
  readonly stdin?: { end(data: string): void } | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): this;
}

export interface SpawnRuntimeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "inherit" | ["pipe", "inherit", "inherit"];
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
  startGateway: typeof startDesktopGateway;
}

export interface StackAddresses {
  apiUrl: string;
  webUrl: string;
}

const defaultDependencies: StackDependencies = {
  spawn: (command, args, options) => spawn(command, [...args], options),
  allocatePort: () => reserveLoopbackPort(),
  waitForUrl: (url) => waitForHealthyUrl(url),
  startGateway: startDesktopGateway,
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
  private gateway?: DesktopGateway;
  private capability = "";
  private localCookie = "";

  async localRequest(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.addresses || !path.startsWith("/") || path.startsWith("//")) throw new Error("Local runtime required");
    const headers = new Headers(init.headers); headers.set("cookie", this.localCookie);
    return fetch(`${this.addresses.apiUrl}${path}`, { ...init, headers, redirect: "error" });
  }

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
    const [apiPort, webPort, gatewayPort] = await Promise.all([
      this.dependencies.allocatePort(),
      this.dependencies.allocatePort(),
      this.dependencies.allocatePort(),
    ]);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const internalWebUrl = `http://127.0.0.1:${webPort}`;
    const webUrl = `http://127.0.0.1:${gatewayPort}`;
    const common: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_PROVIDER: "sqlite",
      CACHE_PROVIDER: "memory",
      OBJECT_STORAGE_PROVIDER: "local",
      EVENTS_PROVIDER: "memory",
      JOBS_PROVIDER: "local",
      DATABASE_URL: `sqlite://${this.layout.databasePath}`,
      LOCAL_STORAGE_PATH: this.layout.filesDirectory,
      FILE_TRANSFER_DIR: join(this.layout.dataDirectory, "file-transfers"),
      BODY_SIZE_LIMIT: "3M",
      AGENT_RELEASE_DIR: this.layout.agentReleaseDirectory,
      PDMUX_DESKTOP_AGENT_CACHE: join(this.layout.dataDirectory, "agent-cache"),
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

    this.capability = randomBytes(32).toString("base64url");
    const api = this.dependencies.spawn(
      this.layout.bunExecutable,
      [this.layout.apiEntry],
      { cwd: dirname(this.layout.apiEntry), env: { ...common, PORT: String(apiPort), PDMUX_DESKTOP_RUNTIME: "1" }, stdio: ["pipe", "inherit", "inherit"] },
    );
    api.stdin?.end(JSON.stringify({ capability: this.capability }));
    const web = this.dependencies.spawn(
      this.layout.bunExecutable,
      [this.layout.webEntry],
      {
        cwd: dirname(this.layout.webEntry),
        env: {
          ...common,
          PORT: String(webPort),
          PROTOCOL_HEADER: "x-forwarded-proto",
          HOST_HEADER: "x-forwarded-host",
          BACKEND_INTERNAL_URL: apiUrl,
          // As in the web image: file transfers have no /api proxy deadline, so
          // the server may not close a silent request.
          CONNECTION_IDLE_TIMEOUT: "0",
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
      this.gateway = await this.dependencies.startGateway(apiUrl, internalWebUrl, gatewayPort);
      await this.dependencies.waitForUrl(`${apiUrl}/health/ready`);
      // The local session is created after startup; probe an asset that needs no session.
      await this.dependencies.waitForUrl(`${webUrl}/favicon.svg`);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.addresses = { apiUrl, webUrl };
    return this.addresses;
  }

  async profiles(): Promise<Array<{ id: string; name: string; email: string }>> {
    const response = await this.bootstrap("profiles", {});
    return response.json() as Promise<Array<{ id: string; name: string; email: string }>>;
  }

  async localSession(profileId?: string): Promise<Response> {
    const response = await this.bootstrap("session", profileId ? { profileId } : {});
    this.localCookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return response;
  }

  async control(action: "attach" | "connect" | "disconnect", data: { url?: string; cookie?: string } = {}): Promise<unknown> {
    if (!this.addresses) throw new Error("Desktop runtime is not running");
    const response = await fetch(`${this.addresses.apiUrl}/desktop/local/control`, {
      method: "POST", headers: { "content-type": "application/json", "x-pdmux-desktop-capability": this.capability, cookie: this.localCookie },
      body: JSON.stringify({ action, ...data }),
    });
    if (!response.ok) throw Object.assign(new Error(`Desktop connection failed (${response.status})`), { code: "DESKTOP_CONNECTION_FAILED" });
    return response.json();
  }

  private async bootstrap(endpoint: string, body: object): Promise<Response> {
    if (!this.addresses) throw new Error("Desktop runtime is not running");
    const response = await fetch(`${this.addresses.apiUrl}/api/auth/desktop-local/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json", "x-pdmux-desktop-capability": this.capability },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Local profile bootstrap failed (${response.status})`);
    return response;
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
    await this.gateway?.close();
    this.gateway = undefined;
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
