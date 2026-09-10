import type { FileTransferEntryView, FileTransferManifestEntry, FileTransferView } from "@pdmux/protocol";
import { api } from "#lib/api.js";

function root(hostId: string, id?: string): string {
  return `/hosts/${encodeURIComponent(hostId)}/file-transfers${id ? "/" + encodeURIComponent(id) : ""}`;
}
export const transferApi = {
  list: (hostId: string): Promise<FileTransferView[]> => api.get(root(hostId)),
  get: (hostId: string, id: string): Promise<FileTransferView> => api.get(root(hostId, id)),
  entries: (hostId: string, id: string): Promise<FileTransferEntryView[]> => api.get(root(hostId, id) + "/entries"),
  create: (hostId: string, input: { id: string; direction: "upload" | "download"; basePath: string; selection: string[] }): Promise<FileTransferView> => api.post(root(hostId), input),
  manifest: (hostId: string, id: string, entries: FileTransferManifestEntry[]): Promise<FileTransferView> => api.post(root(hostId, id) + "/manifest", { entries }),
  control: (hostId: string, id: string, action: "start" | "pause" | "cancel"): Promise<FileTransferView> => api.post(root(hostId, id) + "/control", { action }),
  reconcile: (hostId: string, id: string, entryId: string): Promise<FileTransferEntryView> => api.post(root(hostId, id) + `/entries/${entryId}/reconcile`),
  decision: (hostId: string, id: string, entryId: string, action: "replace" | "skip"): Promise<FileTransferEntryView> => api.post(root(hostId, id) + `/entries/${entryId}/decision`, { action }),
  commit: (hostId: string, id: string, entryId: string): Promise<FileTransferEntryView> => api.post(root(hostId, id) + `/entries/${entryId}/commit`),
  async chunk(hostId: string, id: string, entryId: string, offset: number, digest: string, bytes: Uint8Array): Promise<FileTransferEntryView> {
    const response = await fetch("/api" + root(hostId, id) + `/entries/${entryId}/chunk`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Transfer-Offset": String(offset), "X-Transfer-Sha256": digest },
      body: new Uint8Array(bytes),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "code" in body.error ? String(body.error.code) : "FILES_TRANSFER_IO";
      throw Object.assign(new Error(code), { code });
    }
    return body as FileTransferEntryView;
  },
  url: (hostId: string, id: string): string => "/api" + root(hostId, id) + "/download",
};
