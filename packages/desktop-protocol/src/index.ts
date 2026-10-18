import { z } from "zod";

export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_SCHEME = "dev.podosoft.pdmux";
export const DESKTOP_BRIDGE_PATH = "/desktop/bridge/ws";
export const CHUNK_BYTES = 48 * 1024;
export const WINDOW_CHUNKS = 4;
export const MAX_CHANNELS = 64;
export const MAX_FRAME_BYTES = 96 * 1024;
export const syncRecordSchema = z.object({
  key: z.string().min(1).max(256),
  kind: z.enum(["host", "layout", "widgets", "appearance"]),
  origin: z.string().max(128),
  value: z.record(z.unknown()).nullable(),
}).strict();
export type SyncRecord = z.infer<typeof syncRecordSchema>;
export const syncChangeSchema = syncRecordSchema.extend({
  base: z.string().nullable(), resolutionBase: z.string().optional(), resolution: z.enum(["local", "server"]).optional(),
});
export type SyncChange = z.infer<typeof syncChangeSchema>;
export const syncBatchSchema = z.object({
  version: z.literal(DESKTOP_PROTOCOL_VERSION), deviceId: z.string().uuid(),
  name: z.string().min(1).max(128), changes: z.array(syncChangeSchema).max(2_000),
}).strict();
export interface SyncConflict { key: string; local: SyncRecord; server: SyncRecord; serverHash: string }
export interface SyncResult { version: number; records: Array<SyncRecord & { hash: string }>; conflicts: SyncConflict[]; userId: string; scopeId: string; hostIds: Record<string, string> }

/** Stable JSON avoids depending on object property insertion order or wall clocks. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function chooseChange(base: string | null, local: string, server: string, exists: boolean, resolution?: "local" | "server"): "local" | "server" | "conflict" {
  if (local === server || resolution === "server") return "server";
  if (resolution === "local" || (!exists && base === null) || base === server) return "local";
  if (local === base) return "server";
  return "conflict";
}

const id = z.string().uuid();
export const bridgeFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), id, hostKey: z.string().max(256), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "WS"]), path: z.string().max(8192), headers: z.record(z.string().max(8192)) }).strict(),
  z.object({ type: z.literal("head"), id, status: z.number().int().min(200).max(599), headers: z.record(z.string().max(8192)) }).strict(),
  z.object({ type: z.literal("chunk"), id, data: z.string().max(65_536) }).strict(),
  z.object({ type: z.literal("credit"), id, count: z.number().int().min(1).max(WINDOW_CHUNKS) }).strict(),
  z.object({ type: z.literal("end"), id }).strict(),
  z.object({ type: z.literal("cancel"), id }).strict(),
  z.object({ type: z.literal("error"), id, code: z.string().max(80) }).strict(),
]);
export type BridgeFrame = z.infer<typeof bridgeFrameSchema>;
export interface BridgeRequest { hostKey: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "WS"; path: string; headers: Record<string, string> }

/** Rewrite only host references, including the keyed card preference map. */
export function mapHostIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => mapHostIds(item, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [ids.get(key) ?? key, mapHostIds(item, ids)]));
  return value;
}

/** Remove references to cached hosts from other server accounts before exporting. */
export function omitHostReferences(value: unknown, blocked: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(item => omitHostReferences(item, blocked));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.hostId === "string" && blocked.has(record.hostId)) return null;
    return Object.fromEntries(Object.entries(record).filter(([key]) => !blocked.has(key)).map(([key, item]) => [key, omitHostReferences(item, blocked)]));
  }
  return value;
}
