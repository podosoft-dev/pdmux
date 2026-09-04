import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupService } from "./backup.js";
import { loadDesktopConfig, type DesktopConfig } from "./config.js";
import { desktopMessages } from "./i18n.js";
import { certificateMatches, isAllowedAppNavigation, isAllowedExternalUrl } from "./security.js";
import { StackManager, type RuntimeLayout } from "./stack-manager.js";
import { UpdateCoordinator } from "./updater.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let stack: StackManager | undefined;
let quitting = false;
let restartAttempts = 0;

function logError(action: string, error: unknown, context: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({
    level: "error",
    action,
    message: error instanceof Error ? error.message : String(error),
    ...context,
  })}\n`);
}

function runtimeLayout(userData: string): RuntimeLayout {
  const root = app.isPackaged ? process.resourcesPath : resolve(moduleDirectory, "../../..");
  const dataDirectory = join(userData, "runtime");
  return {
    bunExecutable: app.isPackaged
      ? join(process.resourcesPath, "bin", process.platform === "win32" ? "bun.exe" : "bun")
      : process.env.PDMUX_BUN_EXECUTABLE ?? "bun",
    apiEntry: join(root, app.isPackaged ? "api/main.js" : "apps/api/dist/main.js"),
    migrateEntry: join(root, app.isPackaged ? "api/migrate.js" : "apps/api/dist/migrate.js"),
    webEntry: join(root, app.isPackaged ? "web/index.js" : "apps/web/build/index.js"),
    dataDirectory,
    filesDirectory: join(dataDirectory, "files"),
    databasePath: join(dataDirectory, "pdmux.sqlite"),
    secretPath: join(dataDirectory, "auth.secret"),
    agentReleaseDirectory: join(root, app.isPackaged ? "web/client/agent" : "apps/web/build/client/agent"),
  };
}

function backupService(layout: RuntimeLayout, retention: number): BackupService {
  const script = app.isPackaged
    ? join(process.resourcesPath, "runtime", "sqlite-backup.mjs")
    : resolve(moduleDirectory, "../resources/sqlite-backup.mjs");
  return new BackupService({
    databasePath: layout.databasePath,
    filesDirectory: layout.filesDirectory,
    backupsDirectory: join(dirname(layout.dataDirectory), "backups"),
    bunExecutable: layout.bunExecutable,
    sqliteBackupScript: script,
  }, retention);
}

function secureWindow(appUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(moduleDirectory, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url, appUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, appUrl)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url, appUrl)) void shell.openExternal(url);
  });
  window.once("ready-to-show", () => window.show());
  return window;
}

function configureRemoteCertificatePin(config: DesktopConfig): void {
  if (config.mode !== "remote") return;
  const remoteHost = new URL(config.url).hostname;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== remoteHost) {
      callback(-3);
      return;
    }
    callback(certificateMatches(
      request.hostname,
      request.certificate.fingerprint,
      config.url,
      config.certificatePins,
    ) ? 0 : -2);
  });
}

async function initialize(): Promise<void> {
  const userData = app.getPath("userData");
  const config = await loadDesktopConfig(join(userData, "desktop.json"));
  const messages = desktopMessages(app.getLocale());
  const layout = runtimeLayout(userData);
  const backup = backupService(layout, config.mode === "local" ? config.backupRetention : 5);
  let appUrl: string;

  if (config.mode === "local") {
    stack = new StackManager(layout, {}, (name, code) => {
      logError("Handle desktop runtime exit", "Desktop runtime exited unexpectedly", { name, code });
      if (quitting || restartAttempts >= 3) {
        void dialog.showErrorBox("pdmux", messages.runtimeFailed);
        return;
      }
      const delay = 1_000 * 2 ** restartAttempts;
      restartAttempts += 1;
      setTimeout(() => {
        void stack?.restart().then(({ webUrl }) => mainWindow?.loadURL(webUrl)).catch((error: unknown) => {
          logError("Restart desktop runtime", error);
        });
      }, delay);
    });
    appUrl = (await stack.start()).webUrl;
  } else {
    appUrl = config.url;
    configureRemoteCertificatePin(config);
  }

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = secureWindow(appUrl);
  mainWindow = window;
  window.on("close", (event) => {
    if (quitting || !config.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  await window.loadURL(appUrl);

  const updateBackup = config.mode === "local"
    ? backup
    : { create: (_reason: "update"): Promise<string> => Promise.resolve(userData) };
  const updater = new UpdateCoordinator(app.isPackaged, autoUpdater, updateBackup, async () => {
    const result = await dialog.showMessageBox(window, {
      type: "info",
      message: messages.updateReady,
      buttons: [messages.updateInstall, messages.cancel],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response === 0;
  });
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", () => {
    void updater.installDownloadedUpdate().catch((error: unknown) => logError("Install desktop update", error));
  });

  const icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : resolve(moduleDirectory, "../../web/static"), "favicon.svg"));
  tray = new Tray(icon);
  tray.setToolTip("pdmux");
  tray.on("double-click", () => mainWindow?.show());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: messages.show, click: () => mainWindow?.show() },
    {
      label: messages.backup,
      enabled: config.mode === "local",
      click: () => {
        void backup.create("manual")
          .then((path) => dialog.showMessageBox({ message: messages.backupComplete, detail: path }))
          .catch((error: unknown) => dialog.showErrorBox(messages.backupFailed, error instanceof Error ? error.message : String(error)));
      },
    },
    { label: messages.openData, click: () => { void shell.openPath(userData); } },
    { label: messages.checkUpdates, click: () => { void updater.check().catch((error: unknown) => logError("Check desktop update", error)); } },
    { type: "separator" },
    { label: messages.quit, click: () => { quitting = true; app.quit(); } },
  ]));
  void updater.check().catch((error: unknown) => logError("Check desktop update", error));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on("activate", () => mainWindow?.show());
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", (event) => {
    if (!stack) return;
    event.preventDefault();
    const running = stack;
    stack = undefined;
    void running.stop().finally(() => app.exit(0));
  });
  void app.whenReady().then(initialize).catch((error: unknown) => {
    logError("Initialize desktop application", error);
    dialog.showErrorBox("pdmux", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}
