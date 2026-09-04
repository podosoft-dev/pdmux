import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join } from "node:path";

export interface DesktopRuntimeStageOptions {
  repositoryRoot: string;
  bunExecutable: string;
  platform?: NodeJS.Platform;
}

export interface DesktopRuntimeStageResult {
  agentVersion: string;
  bunDestination: string;
}

export function parseAgentVersion(source: string): string {
  const match = /^\s*(?:var|const)\s+AgentVersion\s*=\s*"([^\"]+)"/m.exec(source);
  const version = match?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Cannot read a SemVer AgentVersion from agent/internal/cli/version.go");
  }
  return version;
}

async function stageApi(repositoryRoot: string, destination: string): Promise<void> {
  const source = join(repositoryRoot, "apps", "api", "dist");
  await mkdir(destination, { recursive: true });
  for (const entry of ["main.js", "migrate.js"] as const) {
    await copyFile(join(source, entry), join(destination, entry));
  }
}

async function stageWeb(repositoryRoot: string, destination: string, agentVersion: string): Promise<void> {
  await cp(join(repositoryRoot, "apps", "web", "build"), destination, { recursive: true });
  const agentRoot = join(destination, "client", "agent");
  const entries = await readdir(agentRoot, { withFileTypes: true });
  const current = entries.find((entry) => entry.isDirectory() && entry.name === agentVersion);
  if (!current) throw new Error(`Web build does not contain agent ${agentVersion}`);
  const currentRoot = join(agentRoot, agentVersion);
  for (const required of [
    "manifest.json",
    "SHA256SUMS",
    "pdmux-agent-linux-amd64",
    "pdmux-agent-linux-arm64",
    "pdmux-agent-darwin-amd64",
    "pdmux-agent-darwin-arm64",
  ] as const) {
    try {
      await stat(join(currentRoot, required));
    } catch {
      throw new Error(`Web build is missing agent ${agentVersion}/${required}`);
    }
  }
  await Promise.all(entries
    .filter((entry) => entry.name !== agentVersion)
    .map((entry) => rm(join(agentRoot, entry.name), { recursive: true, force: true })));
}

export async function stageDesktopRuntime(
  options: DesktopRuntimeStageOptions,
): Promise<DesktopRuntimeStageResult> {
  const resourceRoot = join(options.repositoryRoot, "apps", "desktop", "resources");
  const temporaryRoot = join(resourceRoot, `.stage-${randomUUID()}`);
  const servicesDestination = join(resourceRoot, "services");
  const binDestination = join(resourceRoot, "bin");
  const platform = options.platform ?? process.platform;
  const bunName = platform === "win32" ? "bun.exe" : "bun";
  const stagedBun = join(temporaryRoot, "bin", bunName);
  const agentVersion = parseAgentVersion(await readFile(
    join(options.repositoryRoot, "agent", "internal", "cli", "version.go"),
    "utf8",
  ));

  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  try {
    await stageApi(options.repositoryRoot, join(temporaryRoot, "services", "api"));
    await stageWeb(options.repositoryRoot, join(temporaryRoot, "services", "web"), agentVersion);
    await mkdir(join(temporaryRoot, "bin"), { recursive: true, mode: 0o700 });
    await copyFile(options.bunExecutable, stagedBun);
    if (platform !== "win32") await chmod(stagedBun, 0o755);

    await Promise.all([
      rm(servicesDestination, { recursive: true, force: true }),
      rm(binDestination, { recursive: true, force: true }),
    ]);
    await Promise.all([
      rename(join(temporaryRoot, "services"), servicesDestination),
      rename(join(temporaryRoot, "bin"), binDestination),
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const bunDestination = join(binDestination, bunName);
  await stat(bunDestination);
  return { agentVersion, bunDestination: basename(bunDestination) };
}
