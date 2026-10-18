import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AppException } from "../common/app-exception";
import { isDesktopRuntime } from "./local-auth";

export type AgentFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
interface Artifact { path: string; sha256: string; bytes: number }
interface Catalog { version: string; releaseTag: string; seed: string | null; directory: string; artifacts: Artifact[] }
export class DesktopAgentCache {
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly root = process.env.AGENT_RELEASE_DIR, private readonly cache = process.env.PDMUX_DESKTOP_AGENT_CACHE, private readonly fetcher: AgentFetch = fetch, private readonly enabled: () => boolean = isDesktopRuntime) {}
  private async catalog(version: string): Promise<Catalog> {
    if (!this.enabled() || !this.root || !this.cache || !/^\d+\.\d+\.\d+$/.test(version)) throw new AppException("AGENT_NOT_FOUND", "Agent not found", 404);
    const directory = join(this.root, version);
    const metadata = JSON.parse(await readFile(join(directory, "desktop-catalog.json"), "utf8")) as { version: number; releaseTag: string; seed: string | null; repository: string };
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { version: string; artifacts: Artifact[] };
    if (metadata.version !== 1 || metadata.repository !== "podosoft-dev/pdmux" || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.releaseTag) || manifest.version !== version || ![4, 5].includes(manifest.artifacts.length)) throw new Error("Invalid desktop agent catalog");
    return { version, releaseTag: metadata.releaseTag, seed: metadata.seed, directory, artifacts: manifest.artifacts };
  }
  async current(): Promise<{ version: string; artifacts: object[] } | null> {
    if (!this.enabled() || !this.root) return null;
    for (const version of (await readdir(this.root)).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort().reverse()) {
      try { return { version, artifacts: await this.list(version) }; } catch { /* A source build may have no desktop catalog. */ }
    }
    return null;
  }
  async list(version: string): Promise<object[]> {
    const catalog = await this.catalog(version);
    return Promise.all(catalog.artifacts.map(async artifact => {
      const file = artifact.path.split("/").pop()!;
      const present = await this.existing(catalog, file, artifact);
      return { file, bytes: artifact.bytes, available: Boolean(present), bundled: file === catalog.seed };
    }));
  }
  async ensure(version: string, file: string): Promise<string> {
    if (!/^pdmux-agent-(linux|darwin|windows)-(amd64|arm64)$/.test(file)) throw new AppException("AGENT_NOT_FOUND", "Agent not found", 404);
    const catalog = await this.catalog(version);
    const artifact = catalog.artifacts.find(item => item.path === `/agent/${version}/${file}`);
    if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) throw new AppException("AGENT_NOT_FOUND", "Agent not found", 404);
    const present = await this.existing(catalog, file, artifact);
    if (present) return present;
    const key = `${version}/${file}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.download(catalog, file, artifact).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }
  private async existing(catalog: Catalog, file: string, artifact: Artifact): Promise<string | null> {
    for (const path of [join(catalog.directory, file), join(this.cache!, catalog.version, file)]) {
      try {
        const info = await stat(path);
        if (info.size === artifact.bytes && createHash("sha256").update(await readFile(path)).digest("hex") === artifact.sha256) return path;
      } catch { /* An absent or corrupt cache is downloaded again. */ }
    }
    return null;
  }
  private async download(catalog: Catalog, file: string, artifact: Artifact): Promise<string> {
    const directory = join(this.cache!, catalog.version);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${file}-${crypto.randomUUID()}.tmp`);
    const target = join(directory, file);
    try {
      let url = new URL(`https://github.com/podosoft-dev/pdmux/releases/download/${catalog.releaseTag}/${file}`);
      let response: Response | undefined;
      for (let hop = 0; hop < 5; hop += 1) {
        if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com"))) throw new Error("Untrusted agent download origin");
        response = await this.fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) throw new Error("Missing agent download location");
        url = new URL(location, url);
      }
      if (!response?.ok || !response.body) throw new AppException("DESKTOP_AGENT_DOWNLOAD_FAILED", "Pre-download this platform while online before using it offline", 503);
      const handle = await open(temporary, "wx", 0o600);
      const digest = createHash("sha256"); let bytes = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > artifact.bytes) throw new Error("Agent download is larger than its catalog");
          digest.update(chunk.value); await handle.writeFile(chunk.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); await handle.close(); }
      if (bytes !== artifact.bytes || digest.digest("hex") !== artifact.sha256) throw new AppException("DESKTOP_AGENT_INTEGRITY_FAILED", "The downloaded agent does not match this release", 502);
      await chmod(temporary, 0o755); await rename(temporary, target);
      return target;
    } finally { await rm(temporary, { force: true }); }
  }
}
