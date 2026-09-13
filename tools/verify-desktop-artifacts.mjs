#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopPaths } from "./desktop-package-paths.mjs";
import { verifyAgentResources } from "./verify-macos-desktop.mjs";
import { readFile } from "node:fs/promises";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";

const repository = resolve(import.meta.dirname, "..");

export function selectArtifact(files, extension) {
  const matches = files.filter(name => name.endsWith(extension));
  assert.equal(matches.length, 1, `Require exactly one ${extension} installer`);
  return matches[0];
}

export function windowsInstallArguments(destination) {
  assert.ok(!/[\r\n"]/.test(destination), "Invalid installation directory");
  // NSIS requires /D last and unquoted; it consumes the remaining command line.
  return ["/S", "/currentuser", `/D=${destination}`];
}

async function smoke(directory, screenshot, configuration, preserve) {
  const paths = desktopPaths(directory, process.platform);
  const result = execFileSync(paths.bun, ["-e", 'import {Database} from "bun:sqlite"; const db=new Database(":memory:"); console.log(JSON.stringify({arch:process.arch,value:db.query("select 42 as value").get().value}));db.close();'], { encoding: "utf8", timeout: 30_000 });
  assert.deepEqual(JSON.parse(result.trim()), { arch: process.arch, value: 42 });
  const version = parseAgentVersion(await readFile(join(repository, "agent/internal/cli/version.go"), "utf8"));
  await verifyAgentResources(join(paths.resources, "web/client/agent", version), join(repository, "apps/web/static/agent", version));
  await new Promise((accept, reject) => {
    const child = spawn("node", [join(repository, "tools/smoke-desktop.mjs"), directory, screenshot,
      ...(preserve ? ["--expect-preserved"] : [])], {
      stdio: "inherit", timeout: 180_000,
      env: { ...process.env, PDMUX_SMOKE_CONFIG_ROOT: configuration },
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`Desktop smoke failed: ${code}`)));
  });
}

export async function verifyDesktopArtifacts(directory) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Install packages only on disposable CI runners");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Do not install on self-hosted runners");
  assert.ok(["linux", "win32"].includes(process.platform));
  const files = await readdir(directory);
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-package-verify-"));
  const configuration = join(temporary, "configuration");
  await mkdir(configuration);
  try {
    if (process.platform === "win32") {
      const installer = join(directory, selectArtifact(files, ".exe"));
      const target = join(temporary, "installed app");
      execFileSync(installer, windowsInstallArguments(target), { stdio: "inherit", windowsVerbatimArguments: true, timeout: 120_000 });
      await smoke(target, join(directory, "desktop-installed.png"), configuration, false);
      await smoke(target, join(directory, "desktop-restarted.png"), configuration, true);
      // The whole native runner is disposable; no shared installation is removed.
    } else {
      const deb = join(directory, selectArtifact(files, ".deb"));
      execFileSync("sudo", ["apt-get", "install", "-y", deb], { stdio: "inherit", timeout: 180_000 });
      await smoke("/opt/pdmux", join(directory, "desktop-deb.png"), configuration, false);
      const image = join(directory, selectArtifact(files, ".AppImage"));
      const { chmod } = await import("node:fs/promises");
      await chmod(image, 0o755);
      execFileSync(image, ["--appimage-extract"], { cwd: temporary, stdio: "ignore", timeout: 60_000 });
      const extracted = join(temporary, "squashfs-root");
      // Install the shipped setuid sandbox with its required owner and mode.
      const sandbox = join(extracted, "chrome-sandbox");
      execFileSync("sudo", ["chown", "root:root", sandbox]);
      execFileSync("sudo", ["chmod", "4755", sandbox]);
      await smoke(extracted, join(directory, "desktop-appimage.png"), configuration, true);
      execFileSync("node", [join(repository, "tools/smoke-desktop-downloads.mjs"), extracted], {
        stdio: "inherit", timeout: 180_000,
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.ok(process.argv[2], "Pass the native artifact directory");
  await verifyDesktopArtifacts(resolve(process.argv[2]));
}
