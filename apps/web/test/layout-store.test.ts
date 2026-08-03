/**
 * Personalisation plumbing: which layout a page starts from, and how it is written
 * back without turning one drag into a hundred requests.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultLayout } from "@pdmux/core";
import {
  LAYOUT_CACHE_KEY,
  createLayoutSaver,
  mergeHostPrefs,
  pickLayoutPayload,
  readCachedLayout,
  writeCachedLayout,
  type LayoutStorage,
} from "$lib/dashboard/layout-store";
import { uiTranslate } from "$lib/dashboard/ui-i18n";

function fakeStorage(seed: Record<string, string> = {}): LayoutStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("[TC-PDUI-109] which layout a session starts from", () => {
  it("prefers the user's default layout over any other saved one", () => {
    const payload = pickLayoutPayload({
      layouts: [
        { name: "wide", isDefault: false, payload: { mode: "split9" }, updatedAt: "" },
        { name: "default", isDefault: true, payload: { mode: "split4" }, updatedAt: "" },
      ],
      hostPrefs: {},
    });
    expect(payload).toEqual({ mode: "split4" });
  });

  it("returns null when the user has never saved one", () => {
    expect(pickLayoutPayload({ layouts: [], hostPrefs: {} })).toBeNull();
    expect(pickLayoutPayload(null)).toBeNull();
  });

  it("folds per-host widget rows over the layout's own card map", () => {
    const merged = mergeHostPrefs({ h1: { agents: false } }, { h1: { resources: false }, h2: { links: false } });
    // The row is the newest thing the user touched, so it wins where they overlap.
    expect(merged.h1).toEqual({ agents: false, resources: false });
    expect(merged.h2).toEqual({ links: false });
  });

  it("drops junk from a stored preference instead of trusting it", () => {
    const merged = mergeHostPrefs({}, { h1: { agents: "yes", nonsense: true } });
    expect(merged.h1 ?? {}).toEqual({});
  });
});

describe("[TC-PDUI-110] saving the layout", () => {
  it("coalesces a burst into one write and skips a no-op", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const timers: (() => void)[] = [];
    const saver = createLayoutSaver({
      save,
      schedule: (fn) => timers.push(fn),
      cancel: () => undefined,
    });

    // A splitter drag emits a layout per pointer move.
    saver.queue({ ...defaultLayout(), sidebarWidth: 301 });
    saver.queue({ ...defaultLayout(), sidebarWidth: 302 });
    saver.queue({ ...defaultLayout(), sidebarWidth: 303 });
    timers.pop()?.();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ sidebarWidth: 303 });

    // Paging back and forth returns a layout the server already has.
    saver.queue({ ...defaultLayout(), sidebarWidth: 303 });
    timers.pop()?.();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("retries an identical layout after a failed write", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const timers: (() => void)[] = [];
    const saver = createLayoutSaver({ save, schedule: (fn) => timers.push(fn), cancel: () => undefined });

    saver.queue({ ...defaultLayout(), sidebarWidth: 320 });
    timers.pop()?.();
    await Promise.resolve();
    // Without clearing the de-duplication key the server would stay behind forever.
    saver.queue({ ...defaultLayout(), sidebarWidth: 320 });
    timers.pop()?.();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("writes nothing more once disposed", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const timers: (() => void)[] = [];
    const saver = createLayoutSaver({ save, schedule: (fn) => timers.push(fn), cancel: () => undefined });
    saver.dispose();
    saver.queue(defaultLayout());
    saver.flush();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("[TC-PDUI-111] the first-paint cache", () => {
  it("round-trips a layout", () => {
    const storage = fakeStorage();
    writeCachedLayout(storage, { ...defaultLayout(), mode: "split9" });
    expect(readCachedLayout(storage)).toMatchObject({ mode: "split9" });
  });

  it("treats a corrupt or absent cache as no cache at all", () => {
    expect(readCachedLayout(fakeStorage({ [LAYOUT_CACHE_KEY]: "{not json" }))).toBeNull();
    expect(readCachedLayout(fakeStorage())).toBeNull();
    expect(readCachedLayout(null)).toBeNull();
  });

  it("survives a storage that refuses to write", () => {
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeCachedLayout(storage, defaultLayout())).not.toThrow();
  });
});

describe("[TC-PDUI-112] translating the package's keys", () => {
  const t = uiTranslate({ pdmux: { pane: { zoom: "확대 전환" }, empty: "" } });

  it("resolves a dotted key from the app's catalogue", () => {
    expect(t("pdmux.pane.zoom", "Toggle zoom")).toBe("확대 전환");
  });

  it("falls back to the call site's English for a missing or empty key", () => {
    // A half-translated locale must degrade to readable text, never to a key name.
    expect(t("pdmux.pane.close", "Close")).toBe("Close");
    expect(t("pdmux.empty", "Fallback")).toBe("Fallback");
    expect(t("nothing.here.at.all", "Fallback")).toBe("Fallback");
  });
});
