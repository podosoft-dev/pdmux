import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { layoutSchema, rootSchema, widgetsSchema } from "./record-schema";

// The API moved to zod 4 with PodoKit 1.7.5. zod 4's types refuse the one-argument
// `z.record(value)` (the type check catches that) and it checks UUIDs against the RFC
// variant, so the behaviour of the desktop sync records is pinned here: an object
// payload still passes, a non-object does not, and the ids the desktop generates
// (`randomUUID`) are still accepted.
describe("desktop sync record schemas", () => {
  it("accepts a layout whose payload is an object of any values", () => {
    const layout = { name: "default", isDefault: true, payload: { mode: "split4", slots: [], page: 0 } };
    expect(layoutSchema.parse(layout)).toEqual(layout);
  });

  it("rejects a layout payload that is not an object", () => {
    expect(layoutSchema.safeParse({ name: "default", isDefault: true, payload: ["split4"] }).success).toBe(false);
    expect(layoutSchema.safeParse({ name: "default", isDefault: true, payload: "split4" }).success).toBe(false);
  });

  it("keeps widget switches keyed by name", () => {
    const widgets = { hostKey: "host-1", widgets: { resources: false, usage: true } };
    expect(widgetsSchema.parse(widgets)).toEqual(widgets);
  });

  it("accepts the UUIDs the desktop generates and refuses other strings", () => {
    const root = { id: randomUUID(), path: "/srv/app", enabled: true, sortOrder: 0 };
    expect(rootSchema.parse(root)).toEqual(root);
    expect(rootSchema.safeParse({ ...root, id: "not-a-uuid" }).success).toBe(false);
  });
});
