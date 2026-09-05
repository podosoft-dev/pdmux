import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const name = `pdmux-migration-test-${randomUUID()}`;
const password = randomUUID();
const image = process.argv[2];
if (image && (image.startsWith("-") || /\s/.test(image))) throw new Error("Invalid API image reference");
const testEnv = {
  PATH: process.env.PATH ?? "",
  POSTGRES_USER: "podokit",
  POSTGRES_DB: "podokit",
  POSTGRES_PASSWORD: password,
  POSTGRES_HOST: "127.0.0.1",
  BETTER_AUTH_SECRET: randomUUID(),
  BETTER_AUTH_URL: "https://localhost",
  CORS_ORIGIN: "https://localhost",
  NODE_ENV: "production",
  PDMUX_MIGRATION_TEST_ISOLATED: "1",
  ...(image ? { PDMUX_MIGRATION_TEST_IMAGE: image, PDMUX_MIGRATION_TEST_CONTAINER: name } : {}),
};

function docker(args) {
  return execFileSync("docker", ["--context", "default", ...args], {
    encoding: "utf8",
    env: { ...process.env, POSTGRES_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  docker([
    "run", "--detach", "--rm", "--name", name,
    "--label", "io.pdmux.test=migration-upgrade",
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=podokit", "--env", "POSTGRES_DB=podokit",
    "--env", "POSTGRES_PASSWORD",
    "postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297",
  ]);
  const ports = JSON.parse(docker(["inspect", name, "--format", '{{json .NetworkSettings.Ports}}']));
  testEnv.POSTGRES_PORT = ports["5432/tcp"][0].HostPort;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", name, "pg_isready", "-U", "podokit", "-d", "podokit"]);
      ready = true;
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!ready) throw new Error("Isolated PostgreSQL did not become ready");
  const result = spawnSync(process.execPath, [
    "test", "integration/migration-upgrade.spec.ts", "--timeout", "60000",
  ], {
    cwd: `${root}apps/api`, env: testEnv, stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // This unique container is the only disposable data owned by this check.
  const id = docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`, "--filter", "label=io.pdmux.test=migration-upgrade"]);
  if (id) docker(["rm", "--force", id]);
}
