import { t } from "elysia";
import { FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES } from "@pdmux/protocol";
import { AppException } from "../common/app-exception";

export const createTransferBody = t.Object({
  id: t.String({ format: "uuid" }),
  direction: t.Union([t.Literal("upload"), t.Literal("download")]),
  basePath: t.String({ maxLength: 1024 }),
  selection: t.Array(t.String({ minLength: 1, maxLength: 1024 }), { maxItems: 250 }),
});
export const manifestBody = t.Object({
  entries: t.Array(t.Object({
    id: t.String({ format: "uuid" }),
    path: t.String({ minLength: 1, maxLength: 1024 }),
    kind: t.Union([t.Literal("file"), t.Literal("directory")]),
    size: t.Integer({ minimum: 0, maximum: FILE_TRANSFER_MAX_BYTES }),
    fingerprint: t.String({ maxLength: 64 }),
    modified: t.String({ maxLength: 64 }),
  }), { maxItems: 250 }),
});
export const controlBody = t.Object({ action: t.Union([t.Literal("start"), t.Literal("pause"), t.Literal("cancel")]) });
export const decisionBody = t.Object({ action: t.Union([t.Literal("replace"), t.Literal("skip")]) });

export async function transferChunkBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > FILE_TRANSFER_CHUNK_BYTES) throw new AppException("FILES_TRANSFER_CHUNK", "Chunk exceeds the limit", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const buffer = new Uint8Array(FILE_TRANSFER_CHUNK_BYTES);
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return buffer.subarray(0, offset);
      if (offset + next.value.byteLength > buffer.length) {
        await reader.cancel();
        throw new AppException("FILES_TRANSFER_CHUNK", "Chunk exceeds the limit", 413);
      }
      buffer.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
}
