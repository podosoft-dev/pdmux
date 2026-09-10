import { contextBridge, ipcRenderer } from "electron";

async function transfer(name: string, ...args: unknown[]): Promise<unknown> {
  const result: unknown = await ipcRenderer.invoke("pdmux:transfers:" + name, ...args);
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok === true && "value" in result) return result.value;
    if (result.ok === true) return undefined;
    if ("code" in result && typeof result.code === "string") throw Object.assign(new Error(result.code), { code: result.code });
  }
  throw Object.assign(new Error("FILES_TRANSFER_IO"), { code: "FILES_TRANSFER_IO" });
}

contextBridge.exposeInMainWorld("pdmuxDesktop", Object.freeze({
  isDesktop: true,
  platform: process.platform,
  transfers: Object.freeze({
    pickFolder: (): Promise<unknown> => transfer("pick-folder"),
    read: (token: string, path: string, offset: number, length: number): Promise<unknown> => transfer("read", token, path, offset, length),
    release: (token: string): Promise<unknown> => transfer("release", token),
    download: (hostId: string, id: string): Promise<unknown> => transfer("download", hostId, id),
    status: (id: string): Promise<unknown> => transfer("status", id),
    pauseDownload: (id: string): Promise<unknown> => transfer("pause-download", id),
    cancelDownload: (id: string): Promise<unknown> => transfer("cancel-download", id),
  }),
}));
