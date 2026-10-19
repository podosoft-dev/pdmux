export interface UpdateClient {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate?(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateProgress { percent: number; transferred: number; total: number }
export interface UpdateView {
  show(stage: "checking" | "downloading" | "installing", progress?: UpdateProgress): void;
  close(): void;
  confirmDownload(version: string): Promise<boolean>;
  current(): Promise<void>;
  disabled(): Promise<void>;
  failed(): Promise<void>;
  /** The backup failed before anything stopped, so PDMux keeps running. */
  backupFailed(): Promise<void>;
  /** The runtime has already stopped, so PDMux must restart or quit. */
  installFailed(): Promise<void>;
}

export interface UpdateBackup {
  create(reason: "update"): Promise<string>;
}

export class UpdateCoordinator {
  private pending?: Promise<boolean>;
  private stage: "checking" | "downloading" | "installing" | "prompt" = "checking";
  private manual = false;
  private downloaded = false;
  private reported = false;
  private latest: UpdateProgress = { percent: 0, transferred: 0, total: 0 };
  constructor(
    private readonly packaged: boolean,
    private readonly client: UpdateClient,
    private readonly backup: UpdateBackup,
    private readonly confirmInstall: () => Promise<boolean>,
    private readonly prepareInstall: () => Promise<void>,
    private readonly view?: UpdateView,
  ) {}

  check(manual = false): Promise<boolean> {
    if (this.pending) {
      this.manual ||= manual;
      if (manual && (this.stage === "checking" || this.stage === "downloading")) this.view?.show(this.stage, this.stage === "downloading" ? this.latest : undefined);
      return this.pending;
    }
    this.manual = manual;
    this.pending = this.performCheck().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async performCheck(): Promise<boolean> {
    if (!this.packaged) { if (this.manual) await this.view?.disabled(); return false; }
    let interactive = false;
    this.reported = false;
    try {
      if (this.downloaded) return this.manual ? await this.installDownloadedUpdate() : false;
      this.stage = "checking";
      if (this.manual) this.view?.show("checking");
      const result = await this.client.checkForUpdates() as { isUpdateAvailable?: boolean; updateInfo?: { version: string } } | null;
      this.view?.close();
      this.stage = "prompt";
      if (!result) { if (this.manual) await this.view?.disabled(); return false; }
      if (!result.isUpdateAvailable) { if (this.manual) await this.view?.current(); return true; }
      interactive = true;
      if (!this.client.downloadUpdate || !await this.view?.confirmDownload(result.updateInfo?.version ?? "")) return true;
      this.stage = "downloading";
      this.latest = { percent: 0, transferred: 0, total: 0 };
      this.view?.show("downloading", this.latest);
      await this.client.downloadUpdate();
      this.downloaded = true;
      this.view?.close();
      await this.installDownloadedUpdate();
      return true;
    } catch (error) {
      this.view?.close();
      if (!this.reported && (interactive || this.manual)) await this.view?.failed();
      throw error;
    }
  }

  progress(progress: UpdateProgress): void {
    if (!this.pending || this.stage !== "downloading") return;
    const positive = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;
    this.latest = { percent: Math.min(100, positive(progress.percent)), transferred: positive(progress.transferred), total: positive(progress.total) };
    this.view?.show("downloading", this.latest);
  }

  async installDownloadedUpdate(): Promise<boolean> {
    this.stage = "prompt";
    if (!this.packaged || !(await this.confirmInstall())) return false;
    this.stage = "installing";
    this.view?.show("installing");
    try {
      await this.backup.create("update");
    } catch (error) {
      this.view?.close();
      this.reported = true;
      await this.view?.backupFailed();
      throw error;
    }
    this.view?.close();
    try {
      await this.prepareInstall();
      this.client.quitAndInstall();
      return true;
    } catch (error) {
      this.reported = true;
      await this.view?.installFailed();
      throw error;
    }
  }
}
