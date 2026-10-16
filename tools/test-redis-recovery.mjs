import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Starts the API and the worker from source against a disposable PostgreSQL and
// a disposable Redis that the spec stops, replaces and starts again. Only the
// uniquely named containers below are touched.
const root = fileURLToPath(new URL("../", import.meta.url));
const id = randomUUID();
const postgres = `pdmux-redis-recovery-test-${id}-postgres`;
const redis = `pdmux-redis-recovery-test-${id}-redis`;
const label = "io.pdmux.test=redis-recovery";
const password = randomUUID();
const REDIS_IMAGE = "redis:7.4.5-alpine@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08";

function docker(args) {
  return execFileSync("docker", ["--context", "default", ...args], {
    encoding: "utf8",
    env: { ...process.env, POSTGRES_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// The spec replaces the Redis container, so both host ports must stay fixed.
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
const redisPort = await freePort();
const testEnv = {
  PATH: process.env.PATH ?? "",
  POSTGRES_USER: "podokit",
  POSTGRES_DB: "podokit",
  POSTGRES_PASSWORD: password,
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_PORT: String(databasePort),
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: String(redisPort),
  BETTER_AUTH_SECRET: randomUUID(),
  NODE_ENV: "production",
  PDMUX_REDIS_TEST_ISOLATED: "1",
  PDMUX_REDIS_TEST_CONTAINER: redis,
  PDMUX_REDIS_TEST_IMAGE: REDIS_IMAGE,
  PDMUX_REDIS_TEST_PORT: String(redisPort),
  PDMUX_REDIS_TEST_LABEL: label,
};

function removeContainers() {
  for (const name of [postgres, redis]) {
    const found = docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`, "--filter", `label=${label}`]);
    if (found) docker(["rm", "--force", found]);
  }
}

try {
  docker([
    "run", "--detach", "--name", postgres, "--label", label,
    "--publish", `127.0.0.1:${databasePort}:5432`,
    "--env", "POSTGRES_USER=podokit", "--env", "POSTGRES_DB=podokit",
    "--env", "POSTGRES_PASSWORD",
    "postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", postgres, "pg_isready", "-U", "podokit", "-d", "podokit"]);
      ready = true;
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!ready) throw new Error("Isolated PostgreSQL did not become ready");
  // Created stopped: the spec starts the API before Redis exists.
  docker(["create", "--name", redis, "--label", label, "--publish", `127.0.0.1:${redisPort}:6379`, REDIS_IMAGE]);
  const result = spawnSync(process.execPath, [
    "test", "integration/redis-recovery.spec.ts", "--timeout", "180000",
  ], {
    cwd: `${root}apps/api`, env: testEnv, stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  removeContainers();
}
