import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ObjectBody, ObjectStore } from "./object-store";

function normalizeKey(key: string): string {
  if (!key || key.includes("\0") || isAbsolute(key) || /^[A-Za-z]:/.test(key)) {
    throw new Error("Object key must be a safe relative path");
  }
  const segments = key.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Object key must be a safe relative path");
  }
  return segments.join("/");
}

async function bytes(body: ObjectBody): Promise<Uint8Array> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return body;
}

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly ready: Promise<string>;

  constructor(rootDirectory: string, private readonly publicBaseUrl = "/storage") {
    if (!isAbsolute(rootDirectory)) throw new Error("Local object storage path must be absolute");
    this.root = resolve(rootDirectory);
    this.ready = mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => realpath(this.root));
  }

  async put(key: string, body: ObjectBody): Promise<void> {
    const path = await this.path(key, true);
    const temporary = join(dirname(path), `.pdmux-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, await bytes(body), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(await this.path(key, false));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.get(key);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  presignedGetUrl(key: string): Promise<string> {
    const normalized = normalizeKey(key);
    const encoded = normalized.split("/").map(encodeURIComponent).join("/");
    return Promise.resolve(`${this.publicBaseUrl.replace(/\/$/, "")}/${encoded}`);
  }

  async delete(key: string): Promise<void> {
    await unlink(await this.path(key, false)).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }

  close(): void {}

  private async path(key: string, createParents: boolean): Promise<string> {
    const root = await this.ready;
    const normalized = normalizeKey(key);
    const candidate = resolve(root, ...normalized.split("/"));
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Object key escapes local storage");
    }
    const parent = dirname(candidate);
    if (createParents) await this.ensureParents(root, parent);
    else await this.rejectLinkedParents(root, parent);
    return candidate;
  }

  private async ensureParents(root: string, parent: string): Promise<void> {
    const segments = relative(root, parent).split(sep).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const details = await lstat(current);
        if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe object path");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
  }

  private async rejectLinkedParents(root: string, parent: string): Promise<void> {
    const segments = relative(root, parent).split(sep).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe object path");
    }
  }
}
