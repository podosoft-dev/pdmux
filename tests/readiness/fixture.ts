import { test as base, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { StackManager, type RuntimeProcess, type StackAddresses } from "../../apps/desktop/src/stack-manager";

const repository = resolve(__dirname, "../..");
const execute = promisify(execFile);
// Production refuses documentation-domain administrators. These private-network
// addresses receive no mail and exist only in the disposable runtime.
const emails = ["readiness-owner@pdmux-readiness.internal", "readiness-other@pdmux-readiness.internal"];

function bootstrapAfterMigration(migration: ReturnType<typeof spawn>, env: NodeJS.ProcessEnv, password: string): RuntimeProcess {
  let current = migration;
  const sequence = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: (signal?: NodeJS.Signals): boolean => current.kill(signal),
  });
  const finish = (code: number | null): void => { sequence.exitCode = code; sequence.emit("exit", code); };
  const next = (index: number): void => {
    const email = emails[index];
    if (!email) { finish(0); return; }
    current = spawn("bun", [join(repository, "apps/api/scripts/bootstrap-admin.mjs")], {
      cwd: join(repository, "apps/api"), stdio: "inherit", timeout: 30_000,
      env: { ...env, ADMIN_BOOTSTRAP_EMAIL: email, ADMIN_BOOTSTRAP_PASSWORD: password, ADMIN_BOOTSTRAP_NAME: `Readiness ${index}` },
    });
    current.once("error", () => finish(1));
    current.once("exit", code => code === 0 ? next(index + 1) : finish(code));
  };
  migration.once("error", () => finish(1));
  migration.once("exit", code => code === 0 ? next(0) : finish(code));
  return sequence;
}

export interface ReadinessRuntime extends StackAddresses {
  owner: APIRequestContext;
  other: APIRequestContext;
  container: string;
  executeAgent: (args: string[]) => Promise<string>;
  installAgent: (command: string) => Promise<void>;
}

export async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}: ${response.ok() ? "" : await response.text()}`).toBe(true);
  return await response.json() as T;
}

export const test = base.extend<object, { runtime: ReadinessRuntime }>({
  runtime: [async ({ playwright }, use): Promise<void> => {
    const temporary = await mkdtemp(join(tmpdir(), "pdmux-readiness-"));
    const container = `pdmux-readiness-${randomUUID()}`;
    const password = `${randomUUID()}!Az9`;
    const postgresContainer = `${container}-postgres`;
    const postgres = process.env.READINESS_DATABASE === "postgres";
    const apiDirectory = join(repository, "apps/api");
    let databaseEnvironment: NodeJS.ProcessEnv = {};
    const stack = new StackManager({
      bunExecutable: "bun",
      apiEntry: join(apiDirectory, "dist/main.js"),
      // SQLite takes the desktop's schema step; PostgreSQL runs the product migrations.
      migrateEntry: join(apiDirectory, postgres ? "dist/migrate.js" : "dist/desktop-migrate.js"),
      webEntry: join(repository, "apps/web/build/index.js"),
      dataDirectory: temporary,
      filesDirectory: join(temporary, "files"),
      databasePath: join(temporary, "pdmux.sqlite"),
      secretPath: join(temporary, "auth-secret"),
      agentReleaseDirectory: join(repository, "apps/web/static/agent"),
    }, {
      spawn: (command, args, options) => {
        // This is the self-hosted server profile, even though its process lifecycle
        // reuses the desktop stack supervisor and SQLite schema helper.
        const env = { ...options.env, ...databaseEnvironment, PDMUX_DESKTOP_RUNTIME: "0", ADMIN_EMAILS: emails.join(","), AUTH_REQUIRE_SIGNUP_APPROVAL: "false", AUTH_HIBP_ENABLED: "false", AUDIT_LOG_ENABLED: "true" };
        const child = spawn(command, [...args], {
          ...options,
          // The API reads its migration list from dist/ under its working directory,
          // as in the API image. Starting inside dist/ would instead read dist/dist/.
          cwd: postgres && options.cwd === join(apiDirectory, "dist") ? apiDirectory : options.cwd,
          env,
        });
        // As on a real install, administrators must be bootstrapped after schema
        // migration and before the server starts; public sign-up cannot create them.
        return args.at(-1)?.endsWith(postgres ? "/migrate.js" : "/desktop-migrate.js")
          ? bootstrapAfterMigration(child, env, password) : child;
      },
    });
    const contexts: APIRequestContext[] = [];
    try {
      if (postgres) {
        await execute("docker", ["run", "--detach", "--name", postgresContainer, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=pdmux", "postgres:16-alpine"]);
        const address = (await execute("docker", ["port", postgresContainer, "5432/tcp"])).stdout.trim();
        databaseEnvironment = { DATABASE_PROVIDER: "postgres", DATABASE_URL: `postgres://postgres@${address}/pdmux`, POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: address.split(":")[1], POSTGRES_USER: "postgres", POSTGRES_PASSWORD: password, POSTGRES_DB: "pdmux" };
        // The image's temporary init server accepts Unix sockets before it restarts.
        // Wait for TCP so migrations cannot connect to that short-lived server.
        await expect.poll(async () => (await execute("docker", ["exec", postgresContainer, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).catch(() => ({ stdout: "" }))).stdout, { timeout: 30_000 }).toContain("accepting connections");
      }
      const addresses = await stack.start();
      await execute("docker", ["build", "-f", join(repository, "tests/readiness/Dockerfile.agent"), "-t", "pdmux-readiness-agent:local", join(repository, "tests/readiness")], { timeout: 180_000 });
      await execute("docker", ["run", "--detach", "--name", container, "--network", "host", "pdmux-readiness-agent:local"]);
      for (const email of emails) {
        const context = await playwright.request.newContext({ baseURL: addresses.webUrl, extraHTTPHeaders: { origin: addresses.webUrl } });
        contexts.push(context);
        await json(await context.post("/api/auth/sign-in/email", { data: { email, password } }));
      }
      const [owner, other] = contexts;
      if (!owner || !other) throw new Error("Missing isolated accounts");
      await use({
        ...addresses, owner, other, container,
        executeAgent: async (args): Promise<string> => (await execute("docker", ["exec", container, ...args], { timeout: 60_000 })).stdout,
        installAgent: async (command): Promise<void> => {
          // Execute only the installer generated by this loopback stack, inside a
          // disposable container. Service-manager integration needs a native VM.
          const prefix = `curl -fsSL ${addresses.webUrl}/install.sh | sh -s -- --code `;
          if (!command.startsWith(prefix) || !/^pdmxe_[A-Za-z0-9-]+$/.test(command.slice(prefix.length))) {
            throw new Error(`Unexpected MCP installation origin: ${command.split(" --code ")[0]}; expected ${addresses.webUrl}`);
          }
          await new Promise<void>((accept, reject) => {
            const child = spawn("docker", ["exec", "-i", container, "sh"], { stdio: ["pipe", "ignore", "pipe"], timeout: 60_000 });
            let errors = "";
            child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
            child.once("error", reject);
            child.once("exit", code => code === 0 ? accept() : reject(new Error(`Installer failed (${code}): ${errors.replace(/pdmxe_[A-Za-z0-9-]+/g, "[redacted]")}`)));
            child.stdin.end(`${command} --no-service\n`);
          });
          await execute("docker", ["exec", "--detach", container, "/usr/local/bin/pdmux-agent", "run", "--config", "/etc/pdmux/agent.json"]);
        },
      });
    } finally {
      await execute("docker", ["rm", "--force", container]).catch(() => undefined);
      await Promise.all(contexts.map(context => context.dispose()));
      await stack.stop();
      if (postgres) await execute("docker", ["rm", "--force", postgresContainer]).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true });
    }
  }, { scope: "worker", timeout: 240_000 }],
});

export { expect };
