import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsDirView, FsEntryView } from "@pdmux/ui";
import { FilesDock } from "../src/lib/dashboard/files-dock.svelte";

/**
 * The checkbox column's half in the store: what a box does to the selection.
 *
 * ⚠ A BOX IS NOT A NAME. A click on a name replaces the selection and previews the file;
 * a box adds or removes one entry, never reads anything from the host, and a Shift range
 * from a box takes the state the clicked box is moving to.
 */
const entry = (name: string, over: Partial<FsEntryView> = {}): FsEntryView => ({
  name,
  dir: false,
  symlink: false,
  size: 0,
  modified: 0,
  mode: 0o644,
  ...over,
});

const listingOf = (entries: FsEntryView[], path = ""): FsDirView => ({
  path,
  home: "/home/pdmux",
  entries,
  dropped: 0,
  truncated: false,
  error: null,
});

const docks: FilesDock[] = [];
afterEach(() => {
  for (const dock of docks.splice(0)) dock.transfers.dispose();
});

function dockWith(entries: FsEntryView[]): { dock: FilesDock; read: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async (_host: string, path: string) => ({ path, lines: ["x"], binary: false, truncated: false, bytes: 1, error: null }));
  const list = vi.fn(async (_host: string, path: string) => listingOf(entries, path));
  const dock = new FilesDock({ api: { read, list, url: (host: string, path: string) => `/api/hosts/${host}/files/download?path=${path}` } });
  dock.hostId = "host";
  dock.dir = listingOf(entries);
  docks.push(dock);
  return { dock, read, list };
}

const files = (): FsEntryView[] => [entry("src", { dir: true }), entry("a.ts", { size: 300 }), entry("b.ts", { size: 100 }), entry("c.ts", { size: 200 })];

describe("[TC-PDWEB-036] a checkbox adds to the selection and never reads the host", () => {
  it("toggles one entry, folder or file, without a preview", () => {
    const { dock, read } = dockWith(files());
    dock.check("src", "toggle");
    dock.check("a.ts", "toggle");
    expect(dock.selected).toEqual(["src", "a.ts"]);
    // ⚠ ONE FILE CHECKED IS NOT A REQUEST TO READ IT. The name click previews; the box
    // is how somebody collects ten files to download without the host reading each.
    expect(read).not.toHaveBeenCalled();
    expect(dock.file).toBeNull();
    expect(dock.image).toBeNull();
    dock.check("src", "toggle");
    expect(dock.selected).toEqual(["a.ts"]);
  });

  it("checks the range back to the anchor in the order ON SCREEN, and unchecks it the same way", () => {
    const { dock } = dockWith(files());
    dock.sortBy("size"); // src, b.ts, c.ts, a.ts
    dock.check("b.ts", "toggle");
    dock.check("a.ts", "range");
    // In the host's order `b.ts` … `a.ts` runs backwards past nothing; on screen it
    // runs forwards through `c.ts`.
    expect(dock.selected).toEqual(["b.ts", "c.ts", "a.ts"]);
    // A Shift-click on a CHECKED box unchecks the range back to the anchor (`a.ts` now).
    dock.check("c.ts", "range");
    expect(dock.selected).toEqual(["b.ts"]);
  });

  it("starts a range from the last box clicked, not from the end of the array", () => {
    const { dock } = dockWith([entry("a"), entry("b"), entry("c"), entry("d")]);
    dock.check("d", "toggle");
    dock.check("a", "toggle");
    dock.check("a", "toggle"); // unchecked; still the row the person was looking at
    dock.check("c", "range");
    // From `d` (the end of the array) the range would be c..d. From the anchor it is a..c.
    expect([...dock.selected].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("skips the entries the screen draws disabled", () => {
    // The host's own order, untouched because the sort is the default: a folder between
    // two files, the way a listing sorted by size would place one.
    const { dock } = dockWith([entry("a.ts"), entry("sub", { dir: true }), entry("b.ts")]);
    dock.check("a.ts", "toggle");
    dock.check("b.ts", "range", (item) => !item.dir);
    // ⚠ A range must not tick a box nobody could have ticked — on an agent without folder
    // transfers that folder would make the whole Download refuse.
    expect(dock.selected).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps a preview only while its file is the whole selection", async () => {
    const { dock, read } = dockWith(files());
    dock.select("a.ts", "single");
    await vi.waitFor(() => expect(dock.file?.path).toBe("a.ts"));
    expect(read).toHaveBeenCalledTimes(1);
    dock.check("b.ts", "toggle");
    expect(dock.file).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("replaces and clears the selection for select-all and the clear control", async () => {
    const { dock } = dockWith(files());
    dock.select("a.ts", "single");
    await vi.waitFor(() => expect(dock.file?.path).toBe("a.ts"));
    dock.setSelection(["a.ts", "b.ts", "c.ts"]);
    expect(dock.selected).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(dock.file).toBeNull();
    dock.clearSelection();
    expect(dock.selected).toEqual([]);
  });

  it("belongs to the directory it was made in", async () => {
    const { dock } = dockWith(files());
    dock.check("a.ts", "toggle");
    dock.check("c.ts", "range");
    await dock.openDir("src");
    // ⚠ NAMES, NOT PATHS — a selection carried into another directory would name files
    // that are not there, or worse, different files with the same names.
    expect(dock.selected).toEqual([]);
    // And no anchor survives either: the first Shift-click in the new directory is a click.
    dock.check("b.ts", "range");
    expect(dock.selected).toEqual(["b.ts"]);
  });

  it("keeps what still exists across a refresh, anchor included", async () => {
    const { dock } = dockWith(files());
    dock.check("a.ts", "toggle");
    await dock.refresh();
    expect(dock.selected).toEqual(["a.ts"]);
    dock.check("c.ts", "range");
    expect(dock.selected).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
