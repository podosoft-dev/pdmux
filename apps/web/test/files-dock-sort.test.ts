import { describe, expect, it } from "vitest";
import { FS_COLUMN_MIN, FS_NAME_MIN } from "@pdmux/core";
import { FilesDock } from "../src/lib/dashboard/files-dock.svelte";
import type { FsDirView } from "@pdmux/ui";

/**
 * ⚠ THE SORT LIVES IN THIS STORE AND NOT IN THE COMPONENT, AND THIS FILE IS WHY.
 * A shift-click range is computed on ARRAY INDEX, so a component that reordered rows
 * only for display would make a range select the files lying between two positions in
 * the HOST's order — different files from the ones the person dragged between, with
 * nothing on screen to explain it.
 */
const entry = (name: string, over: Partial<FsDirView["entries"][number]> = {}) => ({
  name,
  dir: false,
  symlink: false,
  size: 0,
  modified: 0,
  mode: 0o644,
  ...over,
});

/** The host's own order: directories first, then by name (`agent/internal/fs`). */
const listing = (): FsDirView => ({
  path: "",
  home: "/home/pdmux",
  entries: [
    entry("src", { dir: true, size: 4096 }),
    entry("a.ts", { size: 300 }),
    entry("b.ts", { size: 100 }),
    entry("c.ts", { size: 200 }),
  ],
  dropped: 0,
  truncated: false,
  error: null,
});

const dockWith = (dir: FsDirView): FilesDock => {
  const dock = new FilesDock({ api: {} as never });
  dock.dir = dir;
  return dock;
};

const shownNames = (dock: FilesDock): string[] => (dock.shown?.entries ?? []).map((e) => e.name);

describe("[TC-PDWEB-031] the file dock owns the order, so the selection agrees with the screen", () => {
  it("hands the host's answer through untouched while the sort is the default one", () => {
    const dock = dockWith(listing());
    // Identity, not a copy: the host already sorted this way, and a needless new array
    // per read would re-key every row in the listing.
    expect(dock.shown).toBe(dock.dir);
  });

  it("reorders through core's rule, keeping directories first", () => {
    const dock = dockWith(listing());
    dock.sortBy("size");
    expect(shownNames(dock)).toEqual(["src", "b.ts", "c.ts", "a.ts"]);
    // A second click on the same column reverses it; folders do not scatter.
    dock.sortBy("size");
    expect(shownNames(dock)).toEqual(["src", "a.ts", "c.ts", "b.ts"]);
    expect(dock.dir?.entries.map((e) => e.name)).toEqual(["src", "a.ts", "b.ts", "c.ts"]);
  });

  it("selects the rows between the two that were clicked ON SCREEN", () => {
    const dock = dockWith(listing());
    dock.sortBy("size"); // src, b.ts, c.ts, a.ts
    dock.select("b.ts", "single");
    dock.select("a.ts", "range");
    // ⚠ THE WHOLE POINT. In the host's order `b.ts` … `a.ts` runs BACKWARDS and would
    // pick `a.ts, b.ts`; on screen it runs forwards through `c.ts`.
    expect(dock.selected).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  it("lists the selection in the order it is drawn", () => {
    const dock = dockWith(listing());
    dock.sortBy("size");
    dock.selected = ["a.ts", "b.ts"];
    // A download names its files in the order somebody sees them, not the order the
    // host happened to send.
    expect(dock.selectedEntries.map((e) => e.name)).toEqual(["b.ts", "a.ts"]);
  });

  it("clamps a dragged column against the panel, not just against itself", () => {
    const dock = dockWith(listing());
    // A dock at its 260px minimum draws only the size column; 240px for it would leave
    // the name column nothing, and the name column is what a person is reading.
    dock.resizeColumn("size", 240, 260);
    expect(dock.columns.size).toBeLessThan(240);
    expect(260 - dock.columns.size).toBeGreaterThan(FS_NAME_MIN);
    // And a value below the column's own floor is refused outright.
    dock.resizeColumn("size", 1, 0);
    expect(dock.columns.size).toBe(FS_COLUMN_MIN.size);
  });
});
