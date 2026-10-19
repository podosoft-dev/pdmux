import { createHash } from "node:crypto";
import { authorizationCode } from "./auth-code.js";
import { app, ipcMain, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { createAuthClient } from "better-auth/client";
import { electronClient } from "@better-auth/electron/client";
import { DESKTOP_PROTOCOL_VERSION, DESKTOP_SCHEME } from "@pdmux/desktop-protocol";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { StackManager } from "./stack-manager.js";

function cloudClient(url: string, values: Map<string, unknown>, save: () => void) {
  return createAuthClient({ baseURL: url, plugins: [electronClient({
    clientID: "pdmux-desktop", signInURL: `${url}/desktop/connect`, protocol: DESKTOP_SCHEME,
    userImageProxy: { enabled: false },
    storage: { getItem: key => values.get(key), setItem: (key, value) => { values.set(key, value); save(); } },
  })] });
}
export class CloudConnection {
  private client?: ReturnType<typeof cloudClient>;
  private url = "";
  private values = new Map<string, unknown>();
  private generation = 0;
  private write = Promise.resolve();
  private readonly file: string;
  constructor(private readonly window: BrowserWindow, private readonly stack: StackManager, private appUrl: string, userData: string, profileId: string, private readonly beforeConnect: () => Promise<unknown>, private readonly defaultServer: string) {
    this.file = join(userData, `cloud-session-${createHash("sha256").update(profileId).digest("hex")}.encrypted`);
  }
  private createClient(): ReturnType<typeof cloudClient> {
    const generation = this.generation;
    return cloudClient(this.url, this.values, () => { if (generation === this.generation) this.persist(); });
  }
  private secureStorage(): boolean {
    return safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  }
  private persist(): void {
    if (!this.secureStorage()) return;
    const data = safeStorage.encryptString(JSON.stringify({ url: this.url, values: [...this.values] }));
    this.write = this.write.then(async () => {
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, this.file);
    }).catch(() => undefined);
  }
  private requireSender(event: IpcMainInvokeEvent): void {
    if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== new URL(this.appUrl).origin) throw new Error("Desktop origin required");
  }
  async initialize(): Promise<void> {
    ipcMain.handle("pdmux:connection:connect", async (event, url: unknown) => {
      this.requireSender(event);
      url ??= this.defaultServer;
      if (typeof url !== "string") throw new Error("Invalid server");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("Use an HTTPS server origin");
      const generation = ++this.generation;
      const response = await fetch(`${parsed.origin}/api/desktop/capabilities`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
      const capabilities: unknown = response.ok ? await response.json() : null;
      if (!capabilities || typeof capabilities !== "object" || !("version" in capabilities) || capabilities.version !== DESKTOP_PROTOCOL_VERSION || !("local" in capabilities) || capabilities.local !== false) throw new Error("The server does not support desktop connections");
      if (generation !== this.generation) throw new Error("Desktop connection was cancelled");
      await this.beforeConnect();
      if (generation !== this.generation) throw new Error("Desktop connection was cancelled");
      await this.stack.control("disconnect");
      if (generation !== this.generation) throw new Error("Desktop connection was cancelled");
      this.values = new Map();
      this.url = parsed.origin;
      this.client = this.createClient();
      this.persist();
      await this.client.requestAuth();
      return { pending: true, persistent: this.secureStorage() };
    });
    ipcMain.handle("pdmux:connection:authenticate", async (event, token: unknown) => {
      this.requireSender(event);
      await this.authenticate(authorizationCode(token)); return { connected: true };
    });
    ipcMain.handle("pdmux:connection:workspace", async (event, organizationId: unknown) => {
      this.requireSender(event);
      if (organizationId !== null && (typeof organizationId !== "string" || organizationId.length > 128)) throw new Error("Invalid workspace");
      const client = this.client; const generation = this.generation;
      if (!client) throw new Error("Sign in first");
      await this.stack.control("disconnect");
      const result = await client.$fetch("/organization/set-active", { method: "POST", body: { organizationId } });
      if (result.error || generation !== this.generation) throw new Error("Workspace selection failed");
      await this.stack.control("connect", { url: this.url, cookie: client.getCookie() });
      this.persist(); return { connected: true };
    });
    ipcMain.handle("pdmux:connection:disconnect", async event => {
      this.requireSender(event); this.generation += 1;
      const client = this.client; this.client = undefined;
      await this.stack.control("disconnect");
      try { await client?.signOut(); } finally { this.values = new Map(); this.persist(); }
      return { connected: false };
    });
    ipcMain.handle("pdmux:connection:open", async (event, page: unknown) => {
      this.requireSender(event);
      if (!this.client?.getCookie() || (page !== "account" && page !== "admin")) throw new Error("Sign in and choose a supported account page");
      await shell.openExternal(new URL(`/${page}`, this.url).href);
    });
    if (this.secureStorage()) {
      try {
        const saved = JSON.parse(safeStorage.decryptString(await readFile(this.file))) as { url: string; values: Array<[string, unknown]> };
        const url = new URL(saved.url);
        if (url.protocol !== "https:" || saved.url !== url.origin) return;
        this.url = url.origin;
        for (const [key, value] of saved.values) this.values.set(key, value);
        this.client = this.createClient();
        if (this.client.getCookie()) await this.stack.control("connect", { url: this.url, cookie: this.client.getCookie() });
      } catch { /* An unavailable server or keychain never prevents local use. */ }
    }
  }
  async handleUrl(value: string): Promise<void> {
    const url = new URL(value);
    if (url.protocol !== `${DESKTOP_SCHEME}:` || `/${url.hostname}${url.pathname}` !== "/auth/callback" || !url.hash.startsWith("#token=")) return;
    await this.authenticate(url.hash.slice(7)); this.window.show(); this.window.focus();
  }
  private async authenticate(token: string): Promise<void> {
    if (!this.client) throw new Error("Start the server login first");
    const client = this.client; const generation = this.generation;
    const result = await client.authenticate({ token: authorizationCode(token) });
    if (generation !== this.generation) { await client.signOut().catch(() => undefined); throw new Error("Desktop connection was cancelled"); }
    if (result.error) throw new Error("Desktop authorization failed");
    await this.stack.control("connect", { url: this.url, cookie: this.client.getCookie() });
    this.persist();
    this.window.webContents.send("pdmux:connection:changed");
  }
  async setAppUrl(url: string): Promise<void> {
    this.appUrl = url;
    if (this.client?.getCookie()) await this.stack.control("connect", { url: this.url, cookie: this.client.getCookie() });
  }
  close(): void {
    for (const name of ["connect", "authenticate", "workspace", "disconnect", "open"]) ipcMain.removeHandler(`pdmux:connection:${name}`);
  }
}

export function registerDesktopProtocol(): void {
  if (app.isPackaged) app.setAsDefaultProtocolClient(DESKTOP_SCHEME);
}
