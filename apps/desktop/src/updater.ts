export interface UpdateClient {
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateBackup {
  create(reason: "update"): Promise<string>;
}

export class UpdateCoordinator {
  constructor(
    private readonly packaged: boolean,
    private readonly client: UpdateClient,
    private readonly backup: UpdateBackup,
    private readonly confirmInstall: () => Promise<boolean>,
  ) {}

  async check(): Promise<boolean> {
    if (!this.packaged) return false;
    await this.client.checkForUpdates();
    return true;
  }

  async installDownloadedUpdate(): Promise<boolean> {
    if (!this.packaged || !(await this.confirmInstall())) return false;
    await this.backup.create("update");
    this.client.quitAndInstall();
    return true;
  }
}
