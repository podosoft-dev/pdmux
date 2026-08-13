/**
 * The file explorer dock's data: which host, which directory, what is selected,
 * and the file being previewed.
 *
 * ⚠ NOTHING IS CACHED HERE, DELIBERATELY. A directory is true for an instant, so
 * re-opening one has to ask again — a person who creates a file in the pane beside
 * this and clicks back must see it. The git dock caches because a tree at a sha is
 * immutable; this is the opposite kind of data.
 *
 * ⚠ THE ROOT IS THE AGENT ACCOUNT'S HOME AND THERE IS NO WAY ABOVE IT. Paths here
 * are relative to that home, always. Sending an absolute path would make the agent's
 * `os.Root` handle meaningless, which is the one thing holding the fence up.
 */
import { previewableAs } from "@pdmux/core";
import type { FsDirView } from "@pdmux/ui";
import type { FsFileView } from "./types";
import { errorCode, filesApi } from "./api";

export interface FilesDockOptions {
  /** Overrides for the API calls, so a test needs no HTTP client. */
  api?: Partial<typeof filesApi>;
}

/** How a click asked for the selection to change. */
export type SelectMode = "single" | "toggle" | "range";

export class FilesDock {
  hostId = $state<string | null>(null);
  /** Relative to the home directory; `''` is the home directory itself. */
  path = $state("");
  dir = $state<FsDirView | null>(null);
  loading = $state(false);
  /** The agent is too old to browse, or its account has no home. */
  unavailable = $state(false);
  /** Names inside `path` — never paths, so a listing change cannot leave a ghost. */
  selected = $state<string[]>([]);
  file = $state<FsFileView | null>(null);
  fileLoading = $state(false);
  /**
   * The image being previewed — a URL the browser fetches itself.
   *
   * ⚠ NOT BYTES THROUGH THIS STORE. An `<img src>` lets the browser stream,
   * decode and cache the picture without the page ever holding it, which is the
   * difference between previewing a 12 MB photo and freezing the tab.
   */
  image = $state<{ path: string; url: string } | null>(null);
  /**
   * The upload in progress, if any.
   *
   * ⚠ ONE FILE AT A TIME, ON PURPOSE. Several concurrent uploads share one
   * host's file budget and interleave their slices, which turns a slow link into
   * several stalled transfers instead of one that finishes. Queued, the first
   * file is usable while the rest arrive.
   */
  upload = $state<{ name: string; sent: number; total: number; queued: number; error: string | null } | null>(null);

  readonly #api: typeof filesApi;
  /** Guards against a slow answer landing after the user moved on. */
  #request = 0;

  constructor(options: FilesDockOptions = {}) {
    this.#api = { ...filesApi, ...options.api };
  }

  /** The full paths of the current selection, which is what the toolbar acts on. */
  get selectedPaths(): string[] {
    return this.selected.map((name) => this.join(name));
  }

  get selectedEntries(): { name: string; dir: boolean; size: number }[] {
    const names = new Set(this.selected);
    return (this.dir?.entries ?? []).filter((entry) => names.has(entry.name));
  }

  join(name: string): string {
    return this.path ? `${this.path}/${name}` : name;
  }

  async openHost(hostId: string): Promise<void> {
    if (this.hostId === hostId) return;
    await this.open(hostId, "");
  }

  /** Point at a host AND a directory in one go — what a restored layout needs. */
  async open(hostId: string, path: string): Promise<void> {
    this.hostId = hostId;
    this.unavailable = false;
    await this.openDir(path);
  }

  async openDir(path: string): Promise<void> {
    const hostId = this.hostId;
    if (!hostId) return;
    const ticket = ++this.#request;
    this.path = path;
    this.selected = [];
    this.file = null;
    this.fileLoading = false;
    this.image = null;
    this.loading = true;
    this.dir = null;
    try {
      const dir = await this.#api.list(hostId, path);
      if (this.#current(ticket)) {
        this.dir = dir;
        this.loading = false;
      }
    } catch (cause) {
      if (!this.#current(ticket)) return;
      this.loading = false;
      // ⚠ "Cannot browse" is a fact about the host, not a failed request: the panel
      // says so in its own words instead of showing an error the user cannot act on.
      this.unavailable = errorCode(cause) === "HOST_FILES_UNSUPPORTED";
      this.dir = this.unavailable
        ? null
        : { path, entries: [], dropped: 0, truncated: false, error: messageOf(cause) };
    }
  }

  /** Re-read the directory now shown, keeping the selection that still exists. */
  async refresh(): Promise<void> {
    const keep = this.selected;
    const openFile = this.file?.path ?? null;
    await this.openDir(this.path);
    const names = new Set((this.dir?.entries ?? []).map((entry) => entry.name));
    this.selected = keep.filter((name) => names.has(name));
    if (openFile && this.selected.length === 1) await this.#preview(openFile);
  }

  /**
   * A click on a row.
   *
   * ⚠ ONLY A SINGLE SELECTION PREVIEWS. Reading a file costs a round trip to the
   * host, and a shift-drag down a directory would ask for every file it crossed.
   */
  select(name: string, mode: SelectMode): void {
    const entries = (this.dir?.entries ?? []).map((entry) => entry.name);
    if (mode === "toggle") {
      this.selected = this.selected.includes(name)
        ? this.selected.filter((other) => other !== name)
        : [...this.selected, name];
    } else if (mode === "range" && this.selected.length) {
      const anchor = entries.indexOf(this.selected[this.selected.length - 1] ?? "");
      const target = entries.indexOf(name);
      if (anchor >= 0 && target >= 0) {
        const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
        this.selected = entries.slice(from, to + 1);
      } else {
        this.selected = [name];
      }
    } else {
      this.selected = [name];
    }

    const only = this.selected.length === 1 && this.selected[0] === name;
    const shape = only ? previewableAs(name) : null;
    this.file = null;
    this.fileLoading = false;
    this.image = shape === "image" && this.hostId ? { path: this.join(name), url: this.#api.url(this.hostId, this.join(name), true) } : null;
    if (shape === "text") void this.#preview(this.join(name));
  }

  closePreview(): void {
    this.file = null;
    this.fileLoading = false;
    this.image = null;
  }

  /**
   * The URLs the browser should download, one per selected file.
   *
   * ⚠ DIRECTORIES ARE LEFT OUT RATHER THAN REFUSED. A selection made by dragging
   * down a listing catches them, and failing the whole action because one row was
   * a folder would be the panel arguing with the user about a click.
   */
  downloadUrls(): { name: string; url: string }[] {
    const hostId = this.hostId;
    if (!hostId) return [];
    return this.selectedEntries
      .filter((entry) => !entry.dir)
      .map((entry) => ({ name: entry.name, url: this.#api.url(hostId, this.join(entry.name)) }));
  }

  /**
   * Navigate to a path the user typed or pasted.
   *
   * ⚠ AN ABSOLUTE PATH IS NOT REFUSED, IT IS INTERPRETED. People paste what `pwd`
   * printed, and refusing that is a puzzle rather than a safety property — the
   * safety is the agent's root handle, which cannot leave the home no matter what
   * arrives. So a path under the home is rewritten relative to it, and anything
   * else falls through to the agent, which answers with a refusal the panel shows.
   */
  async navigate(input: string, home: string | null): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return void (await this.openDir(""));
    let next = trimmed;
    if (home && (next === home || next.startsWith(`${home}/`))) next = next.slice(home.length);
    if (next.startsWith("~")) next = next.slice(1);
    next = next.replace(/^\/+/, "").replace(/\/+$/, "");
    await this.openDir(next);
  }

  /**
   * Send files into the directory being shown.
   *
   * ⚠ THE NAME IS THE FILE'S, AND THE DIRECTORY IS WHAT THE PANEL IS SHOWING —
   * never a path from the drop event. A browser gives no directory for a dropped
   * file (and `webkitRelativePath` only for a picked folder), so inventing one
   * here would mean uploading to a place the user cannot see.
   */
  async uploadFiles(files: readonly File[], onDone: () => void): Promise<void> {
    const hostId = this.hostId;
    if (!hostId || files.length === 0) return;
    for (const [index, file] of files.entries()) {
      this.upload = { name: file.name, sent: 0, total: file.size, queued: files.length - index - 1, error: null };
      try {
        await this.#api.upload(hostId, this.join(file.name), file, (sent, total) => {
          if (this.upload) this.upload = { ...this.upload, sent, total };
        });
      } catch (cause) {
        this.upload = { name: file.name, sent: 0, total: file.size, queued: 0, error: messageOf(cause) };
        return;
      }
    }
    this.upload = null;
    onDone();
  }

  /**
   * Delete what is selected.
   *
   * ⚠ IT DOES NOT ASK — the SCREEN asks, before this is called at all. Putting a
   * confirmation inside a store means the one caller that forgets it deletes
   * silently; keeping the question in the dialog that names what will go keeps
   * the two impossible to separate.
   */
  async removeSelected(recursive: boolean): Promise<string | null> {
    const hostId = this.hostId;
    if (!hostId) return null;
    for (const entry of this.selectedEntries) {
      const answer = await this.#api.remove(hostId, this.join(entry.name), recursive && entry.dir);
      if (answer.error) return answer.error;
    }
    return null;
  }

  async #preview(path: string): Promise<void> {
    const hostId = this.hostId;
    if (!hostId) return;
    const ticket = this.#request;
    this.fileLoading = true;
    this.file = null;
    try {
      const file = await this.#api.read(hostId, path);
      if (this.#current(ticket)) {
        this.file = file;
        this.fileLoading = false;
      }
    } catch (cause) {
      if (!this.#current(ticket)) return;
      this.fileLoading = false;
      this.file = { path, lines: [], binary: false, truncated: false, bytes: 0, error: messageOf(cause) };
    }
  }

  #current(ticket: number): boolean {
    return ticket === this.#request;
  }
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
