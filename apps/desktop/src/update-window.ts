import { BrowserWindow, dialog } from "electron";
import type { DesktopMessages } from "./i18n.js";
import type { UpdateProgress, UpdateView } from "./updater.js";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Native confirmations and a content-only progress window, independent of web navigation. */
export class UpdateWindow implements UpdateView {
  private window?: BrowserWindow;
  private ready?: Promise<void>;
  constructor(private readonly parent: BrowserWindow, private readonly messages: DesktopMessages, private readonly logError: (error: unknown) => void) {}

  show(stage: "checking" | "downloading" | "installing", progress?: UpdateProgress): void {
    if (this.parent.isDestroyed()) return;
    const message = stage === "checking" ? this.messages.updateChecking : stage === "downloading" ? this.messages.updateDownloading : this.messages.updatePreparing;
    this.parent.setProgressBar(stage === "downloading" && progress && progress.total > 0 ? progress.percent / 100 : 2);
    if (!this.window || this.window.isDestroyed()) {
      if (this.parent.isMinimized()) this.parent.restore();
      if (!this.parent.isVisible()) this.parent.show();
      const window = new BrowserWindow({ title: "PDMux", parent: this.parent, width: 440, height: 190, useContentSize: true, resizable: false, minimizable: false, maximizable: false, closable: false, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      this.window = window;
      window.setMenuBarVisibility(false);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>:root{color-scheme:light dark;font:14px system-ui;background:Canvas;color:CanvasText}body{margin:0;padding:24px}h1{font-size:16px;font-weight:600;margin:0 0 16px}p{min-height:20px;margin:0 0 16px;font-variant-numeric:tabular-nums;color:GrayText}progress{width:100%;height:16px}</style></head><body><h1 id="message">${escapeHtml(message)}</h1><p id="detail" role="status" aria-live="polite"></p><progress id="progress" max="100" aria-label="${escapeHtml(this.messages.updateDownloading)}"></progress></body></html>`;
      this.ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    }
    const window = this.window;
    const detail = progress && progress.total > 0 ? `${Math.round(progress.percent)}% · ${(progress.transferred / 1_048_576).toFixed(1)} / ${(progress.total / 1_048_576).toFixed(1)} MiB` : "";
    void this.ready?.then(async () => {
      if (window.isDestroyed()) return;
      await window.webContents.executeJavaScript(`document.getElementById('message').textContent=${JSON.stringify(message)};document.getElementById('detail').textContent=${JSON.stringify(detail)};${progress && progress.total > 0 ? `document.getElementById('progress').value=${progress.percent};` : "document.getElementById('progress').removeAttribute('value');"}`);
    }).catch(error => { if (!window.isDestroyed()) this.logError(error); });
  }

  close(): void {
    this.window?.destroy(); this.window = undefined; this.ready = undefined;
    if (!this.parent.isDestroyed()) this.parent.setProgressBar(-1);
  }
  async confirmDownload(version: string): Promise<boolean> {
    this.parent.show();
    const result = await dialog.showMessageBox(this.parent, { type: "info", title: "PDMux", message: this.messages.updateAvailable.replace("{version}", version), buttons: [this.messages.updateDownload, this.messages.updateLater], defaultId: 0, cancelId: 1, noLink: true });
    return result.response === 0;
  }
  private async notice(message: string, type: "info" | "error" = "info"): Promise<void> {
    this.parent.show();
    await dialog.showMessageBox(this.parent, { type, title: "PDMux", message, buttons: [this.messages.updateClose] });
  }
  current(): Promise<void> { return this.notice(this.messages.updateCurrent); }
  disabled(): Promise<void> { return this.notice(this.messages.updateDisabled); }
  failed(): Promise<void> { return this.notice(this.messages.updateError, "error"); }
}
