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
  ...(process.argv?.includes("--pdmux-local-runtime=1") ? { connection: Object.freeze({
    connect: (url?: string): Promise<unknown> => ipcRenderer.invoke("pdmux:connection:connect", url),
    authenticate: (code: string): Promise<unknown> => ipcRenderer.invoke("pdmux:connection:authenticate", code),
    workspace: (id: string | null): Promise<unknown> => ipcRenderer.invoke("pdmux:connection:workspace", id),
    disconnect: (): Promise<unknown> => ipcRenderer.invoke("pdmux:connection:disconnect"),
    open: (page: "account" | "admin"): Promise<unknown> => ipcRenderer.invoke("pdmux:connection:open", page),
    onChanged: (listener: () => void): (() => void) => { const handler = (): void => listener(); ipcRenderer.on("pdmux:connection:changed", handler); return () => { ipcRenderer.removeListener("pdmux:connection:changed", handler); }; },
  }), actions: Object.freeze({ run: (action: "backup" | "open-data" | "check-updates"): Promise<void> => ipcRenderer.invoke("pdmux:desktop:action", action), onSettings: (listener: () => void): (() => void) => { const handler = (): void => listener(); ipcRenderer.on("pdmux:settings:open", handler); return () => { ipcRenderer.removeListener("pdmux:settings:open", handler); }; } }),
    preferences: Object.freeze({ read: (): Promise<unknown> => ipcRenderer.invoke("pdmux:preferences:read"), save: (value: unknown): Promise<unknown> => ipcRenderer.invoke("pdmux:preferences:save", value) }),
    localAgent: Object.freeze({ status: (): Promise<unknown> => ipcRenderer.invoke("pdmux:local-agent:status"), retry: (): Promise<unknown> => ipcRenderer.invoke("pdmux:local-agent:retry") }),
  } : {}),
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
