import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

export interface SelectedEntry { path: string; kind: "file" | "directory"; size: number; modified: string }
interface Selection { root: string; entries: Map<string, SelectedEntry>; touched: number }
const CHUNK = 1_048_576;
const TTL = 24 * 60 * 60 * 1000;

export class TransferSources {
  private readonly selections = new Map<string, Selection>();

  async select(directory: string): Promise<{ token: string; entries: SelectedEntry[]; exclusions: string[] }> {
    this.expire();
    if (this.selections.size >= 16) throw new Error("FILES_TRANSFER_LIMIT");
    const root = await realpath(directory);
    const entries: SelectedEntry[] = [];
    const exclusions: string[] = [];
    let visited = 0;
    let bytes = 0;
    const visit = async (absolute: string, path: string): Promise<void> => {
      const info = await lstat(absolute);
      if (++visited > 10_000) throw new Error("FILES_TRANSFER_LIMIT");
      // Report exclusions for explicit review, and never follow links.
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) { exclusions.push(path); return; }
      const kind = info.isDirectory() ? "directory" : "file";
      const size = kind === "file" ? info.size : 0;
      entries.push({ path, kind, size, modified: String(info.mtimeMs) });
      bytes += size;
      if (entries.length > 10_000 || bytes > 10 * 1024 ** 3) throw new Error("FILES_TRANSFER_LIMIT");
      if (kind === "directory") {
        const directory = await opendir(absolute, { bufferSize: 250 });
        for await (const child of directory) await visit(join(absolute, child.name), path + "/" + child.name);
      }
    };
    await visit(root, basename(root));
    const token = randomUUID();
    this.selections.set(token, { root, entries: new Map(entries.map((entry) => [entry.path, entry])), touched: Date.now() });
    return { token, entries, exclusions };
  }
  async read(token: string, path: string, offset: number, length: number): Promise<Uint8Array> {
    this.expire();
    const selection = this.selections.get(token);
    const entry = selection?.entries.get(path);
    if (!selection || !entry || entry.kind !== "file" || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0 || length > CHUNK || offset + length > entry.size) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
    const file = join(selection.root, ...path.split("/").slice(1));
    const resolved = await realpath(file);
    const inside = relative(selection.root, resolved);
    if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) throw new Error("FILES_TRANSFER_PATH");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || String(info.mtimeMs) !== entry.modified) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== entry.size || String(opened.mtimeMs) !== entry.modified) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
      selection.touched = Date.now();
      return new Uint8Array(buffer);
    } finally { await handle.close(); }
  }
  release(token: string): void { this.selections.delete(token); }
  private expire(): void {
    for (const [key, value] of this.selections) if (Date.now() - value.touched > TTL) this.selections.delete(key);
  }
}
