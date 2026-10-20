// [TC-PDUI-236] Real SQLite services and native PTY in a disposable profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StackManager } from "../apps/desktop/src/stack-manager.ts";

const repository = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "pdmux-presentation-stack-"));
await mkdir(join(root, "node_modules"));
await cp(join(repository, "apps/api/dist-desktop"), join(root, "api"), { recursive: true });
const stack = new StackManager({
  bunExecutable: process.execPath,
  apiEntry: join(root, "api/main.js"), migrateEntry: join(root, "api/desktop-migrate.js"),
  webEntry: join(repository, "apps/web/build-desktop/index.js"),
  dataDirectory: join(root, "profile"), filesDirectory: join(root, "profile/files"),
  databasePath: join(root, "profile/pdmux.sqlite"), secretPath: join(root, "profile/auth.secret"),
  agentReleaseDirectory: join(repository, "apps/web/static/agent"),
}, { spawn: (command, args, options) => spawn(command, [...args], {
  ...options, env: { ...options.env, BUN_INSTALL_CACHE_DIR: join(root, "cold-cache"), npm_config_registry: "http://127.0.0.1:1" },
}) });
try {
  const { apiUrl, webUrl } = await stack.start();
  const response = await stack.localSession();
  await stack.control("attach");
  const state = join(root, "browser-state.json");
  const cookies = response.headers.getSetCookie().map(value => {
    const pair = value.split(";")[0]; const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" };
  });
  cookies.push({ name: "locale", value: "en", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" });
  await writeFile(state, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  const child = spawn("node", [join(repository, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.config.ts", "--project", "ui", "--no-deps", "ui/pdmux-terminal-presentation.ui.spec.ts", ...(process.env.PDMUX_PRESENTATION_HEADED === "1" ? ["--headed"] : [])], {
    cwd: join(repository, "tests"), stdio: "inherit",
    env: { ...process.env, E2E_BASE_URL: webUrl, E2E_WORKERS: "1", PDMUX_PRESENTATION_STORAGE_STATE: state, PDMUX_PRESENTATION_AGENT_ORIGIN: apiUrl },
  });
  const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("exit", accept); });
  assert.equal(code, 0, "Native terminal presentation verification failed");
} finally { await stack.stop(); await rm(root, { recursive: true, force: true }); }
