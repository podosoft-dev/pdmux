import { FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, FILE_TRANSFER_MAX_ENTRIES, type FileTransferManifestEntry } from "@pdmux/protocol";

export interface UploadSource {
  entries: FileTransferManifestEntry[];
  exclusions?: string[];
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  release?(): Promise<void>;
}
export type ScanProgress = (path: string, count: number) => void;
interface DirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
}
interface FileHandle { kind: "file"; name: string; getFile(): Promise<File> }
export interface DesktopSourceEntry { path: string; kind: "file" | "directory"; size: number; modified: string }
export interface DesktopTransfers {
  pickFolder(): Promise<{ token: string; entries: DesktopSourceEntry[]; exclusions?: string[] } | null>;
  read(token: string, path: string, offset: number, length: number): Promise<Uint8Array>;
  release(token: string): Promise<void>;
  download(hostId: string, transferId: string): Promise<void>;
  status(id: string): Promise<NativeDownload | null>;
  pauseDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
}
export interface NativeDownload {
  id: string;
  received: number;
  total: number;
  state: "progressing" | "interrupted" | "completed" | "cancelled";
}
interface TransferWindow extends Window {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
  pdmuxDesktop?: { isDesktop: boolean; transfers?: DesktopTransfers };
}
export function desktopTransfers(): DesktopTransfers | undefined {
  return typeof window === "undefined" ? undefined : (window as TransferWindow).pdmuxDesktop?.transfers;
}
export function canPickFolder(): boolean {
  return Boolean(desktopTransfers() || (typeof window !== "undefined" && (window as TransferWindow).showDirectoryPicker));
}
function validate(entries: FileTransferManifestEntry[], bytes: number): void {
  if (entries.length > FILE_TRANSFER_MAX_ENTRIES || bytes > FILE_TRANSFER_MAX_BYTES) throw new Error("FILES_TRANSFER_LIMIT");
}
function entry(path: string, kind: "file" | "directory", size = 0, modified = ""): FileTransferManifestEntry {
  if (!path || path.length > 1024 || /[\\\x00:]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("FILES_TRANSFER_PATH");
  return { id: crypto.randomUUID(), path, kind, size, fingerprint: "", modified };
}
class BrowserSource implements UploadSource {
  entries: FileTransferManifestEntry[] = [];
  private readonly readers = new Map<string, () => Promise<File>>();
  private bytes = 0;
  constructor(private readonly progress: ScanProgress) {}
  addDirectory(path: string): void {
    this.entries.push(entry(path, "directory"));
    validate(this.entries, this.bytes);
    this.progress(path, this.entries.length);
  }
  async addFile(path: string, read: () => Promise<File>): Promise<void> {
    const file = await read();
    this.bytes += file.size;
    this.entries.push(entry(path, "file", file.size, String(file.lastModified)));
    validate(this.entries, this.bytes);
    this.readers.set(path, read);
    this.progress(path, this.entries.length);
  }
  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (length > FILE_TRANSFER_CHUNK_BYTES) throw new Error("FILES_TRANSFER_CHUNK");
    const read = this.readers.get(path);
    const expected = this.entries.find((entry) => entry.path === path);
    if (!read || !expected) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
    const file = await read();
    if (file.size !== expected.size || String(file.lastModified) !== expected.modified) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  }
}
export async function sourceFromFiles(files: readonly File[], progress: ScanProgress = (): void => {}): Promise<UploadSource> {
  const source = new BrowserSource(progress);
  for (const file of files) await source.addFile(file.name, () => Promise.resolve(file));
  return source;
}
export async function sourceFromDirectory(handle: DirectoryHandle, progress: ScanProgress = (): void => {}): Promise<UploadSource> {
  const source = new BrowserSource(progress);
  const visit = async (handle: DirectoryHandle | FileHandle, path: string): Promise<void> => {
    if (handle.kind === "file") { await source.addFile(path, () => handle.getFile()); return; }
    source.addDirectory(path);
    for await (const child of handle.values()) await visit(child, path + "/" + child.name);
  };
  await visit(handle, handle.name);
  return source;
}
export async function pickFolder(progress: ScanProgress = (): void => {}): Promise<UploadSource | null> {
  const desktop = desktopTransfers();
  if (desktop) {
    const picked = await desktop.pickFolder();
    if (!picked) return null;
    const entries = picked.entries.map((value) => entry(value.path, value.kind, value.size, value.modified));
    validate(entries, entries.reduce((total, entry) => total + entry.size, 0));
    for (const entry of entries) progress(entry.path, entries.length);
    return {
      entries,
      exclusions: picked.exclusions,
      read: (path, offset, length) => desktop.read(picked.token, path, offset, length),
      release: () => desktop.release(picked.token),
    };
  }
  const picker = (window as TransferWindow).showDirectoryPicker;
  if (!picker) throw new Error("FILES_TRANSFER_PICKER_UNSUPPORTED");
  return sourceFromDirectory(await picker.call(window), progress);
}

export interface DroppedEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file(success: (file: File) => void, error: (error: DOMException) => void): void;
  createReader(): { readEntries(success: (entries: DroppedEntry[]) => void, error: (error: DOMException) => void): void };
}
export async function sourceFromDroppedEntries(entries: readonly DroppedEntry[], progress: ScanProgress = (): void => {}): Promise<UploadSource> {
  const source = new BrowserSource(progress);
  const visit = async (item: DroppedEntry, path: string): Promise<void> => {
    if (item.isFile) {
      await source.addFile(path, () => new Promise<File>((resolve, reject) => item.file(resolve, reject)));
    } else if (item.isDirectory) {
      source.addDirectory(path);
      const reader = item.createReader();
      while (true) {
        // Chromium returns at most 100 children per call, not the whole directory.
        const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, path + "/" + child.name);
      }
    } else throw new Error("FILES_TRANSFER_SOURCE_UNSUPPORTED");
  };
  for (const item of entries) await visit(item, item.name);
  return source;
}
export function captureDrop(transfer: DataTransfer): { entries: DroppedEntry[]; files: File[] } {
  // The protected drag store must be read synchronously inside the drop event.
  const entries: DroppedEntry[] = [];
  for (const item of transfer.items) {
    const value = item.webkitGetAsEntry?.();
    if (value) entries.push(value as unknown as DroppedEntry);
  }
  return { entries, files: [...transfer.files] };
}
export async function chunkDigest(bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function fingerprintSource(
  source: UploadSource,
  progress: (path: string, bytes: number, total: number) => void,
  cancelled: () => boolean = (): boolean => false,
): Promise<void> {
  const total = source.entries.reduce((sum, entry) => sum + entry.size, 0);
  let bytes = 0;
  for (const entry of source.entries) {
    if (cancelled()) throw new Error("FILES_TRANSFER_PAUSED");
    if (entry.kind === "directory") continue;
    const hashes: string[] = [];
    for (let offset = 0; offset < entry.size; offset += FILE_TRANSFER_CHUNK_BYTES) {
      if (cancelled()) throw new Error("FILES_TRANSFER_PAUSED");
      const data = await source.read(entry.path, offset, Math.min(FILE_TRANSFER_CHUNK_BYTES, entry.size - offset));
      if (data.length !== Math.min(FILE_TRANSFER_CHUNK_BYTES, entry.size - offset)) throw new Error("FILES_TRANSFER_SOURCE_CHANGED");
      hashes.push(await chunkDigest(data));
      bytes += data.length;
      progress(entry.path, bytes, total);
    }
    entry.fingerprint = await chunkDigest(new TextEncoder().encode(hashes.join("")));
  }
}
