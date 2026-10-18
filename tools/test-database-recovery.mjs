import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Starts the API from source against a disposable PostgreSQL that the spec
// stops, pauses and starts again. Only the unique container below is touched.
const root = fileURLToPath(new URL("../", import.meta.url));
const name = `pdmux-recovery-test-${randomUUID()}`;
const password = randomUUID();

function docker(args) {
  return execFileSync("docker", ["--context", "default", ...args], {
    encoding: "utf8",
    env: { ...process.env, POSTGRES_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// The spec restarts the container, so its host port must not change.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const databasePort = await freePort();
const testEnv = {
  PATH: process.env.PATH ?? "",
  POSTGRES_USER: "podokit",
  POSTGRES_DB: "podokit",
  POSTGRES_PASSWORD: password,
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_PORT: String(databasePort),
  BETTER_AUTH_SECRET: randomUUID(),
  BETTER_AUTH_URL: "https://localhost",
  CORS_ORIGIN: "https://localhost",
  NODE_ENV: "production",
  PDMUX_RECOVERY_TEST_ISOLATED: "1",
  PDMUX_RECOVERY_TEST_CONTAINER: name,
};

try {
  docker([
    "run", "--detach", "--name", name,
    "--label", "io.pdmux.test=database-recovery",
    "--publish", `127.0.0.1:${databasePort}:5432`,
    "--env", "POSTGRES_USER=podokit", "--env", "POSTGRES_DB=podokit",
    "--env", "POSTGRES_PASSWORD",
    "postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      // Over TCP: the image's first start runs a socket-only server for initdb, stops it
      // and starts the real one, so a socket check passes before the port is served.
      docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "podokit", "-d", "podokit"]);
      ready = true;
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!ready) throw new Error("Isolated PostgreSQL did not become ready");
  const result = spawnSync(process.execPath, [
    "test", "integration/database-recovery.spec.ts", "--timeout", "120000",
  ], {
    cwd: `${root}apps/api`, env: testEnv, stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // The spec may leave it paused; removal works either way.
  const id = docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`, "--filter", "label=io.pdmux.test=database-recovery"]);
  if (id) docker(["rm", "--force", id]);
}
