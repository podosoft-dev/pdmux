import { describe, expect, it } from "bun:test";
import { bridgeFrameSchema, canonical, chooseChange, mapHostIds, syncBatchSchema } from "./index.js";

describe("[TC-PDDESKTOP-012] desktop synchronization decisions", () => {
  it("merges independent changes and keeps concurrent edits for review", () => {
    expect(chooseChange(null, "local", "none", false)).toBe("local");
    expect(chooseChange("base", "local", "base", true)).toBe("local");
    expect(chooseChange("base", "base", "server", true)).toBe("server");
    expect(chooseChange("base", "local", "server", true)).toBe("conflict");
    expect(chooseChange(null, "local", "server", true)).toBe("conflict");
  });
  it("does not resurrect a deletion without resolving its conflict", () => {
    expect(chooseChange("base", "base", "deleted", true)).toBe("server");
    expect(chooseChange("base", "modified", "deleted", true)).toBe("conflict");
    expect(chooseChange("base", "modified", "deleted", true, "server")).toBe("server");
  });
  it("hashes stable JSON and translates keyed preferences with host references", () => {
    expect(canonical({ z: 1, a: { y: 2, b: true } })).toBe(canonical({ a: { b: true, y: 2 }, z: 1 }));
    expect(() => JSON.parse(canonical({ a: 1 }))).not.toThrow();
    expect(mapHostIds({ slots: [{ hostId: "local" }], cards: { local: { cpu: true } } }, new Map([["local", "cloud"]]))).toEqual({ slots: [{ hostId: "cloud" }], cards: { cloud: { cpu: true } } });
  });
  it("rejects unversioned batches and arbitrary proxy methods", () => {
    expect(syncBatchSchema.safeParse({ deviceId: crypto.randomUUID(), name: "test", changes: [] }).success).toBe(false);
    expect(bridgeFrameSchema.safeParse({ type: "open", id: crypto.randomUUID(), hostKey: "host", method: "CONNECT", path: "http://internal", headers: {} }).success).toBe(false);
  });
});
