import { CloudConnection, registerDesktopProtocol } from "./cloud-connection.js";
import { LocalAgent } from "./local-agent.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from "electron";
import electronUpdater from "electron-updater";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { userDataDirectory } from "./user-data.js";
import { BackupService } from "./backup.js";
import { loadDesktopConfig, type DesktopConfig } from "./config.js";
import { desktopMessages } from "./i18n.js";
import { logError } from "./log.js";
import { certificateMatches, isAllowedAppNavigation, isAllowedExternalUrl, isAllowedFontPermission } from "./security.js";
import { StackManager, type RuntimeLayout } from "./stack-manager.js";
import { UpdateCoordinator } from "./updater.js";
import { UpdateWindow } from "./update-window.js";
import { DesktopFileTransfers } from "./file-transfers.js";
import { TerminalPreferencesFile } from "./terminal-preferences.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let stack: StackManager | undefined;
let fileTransfers: DesktopFileTransfers | undefined;
let cloud: CloudConnection | undefined;
let localAgent: LocalAgent | undefined;
let pendingDeepLink: string | undefined;
let quitting = false;
let restartAttempts = 0;
let runtimeStop: Promise<void> | undefined;

function stopRuntime(): Promise<void> {
  if (runtimeStop) return runtimeStop;
  cloud?.close(); cloud = undefined;
  const running = stack;
  const transfers = fileTransfers;
  const agent = localAgent; localAgent = undefined;
  stack = undefined;
  fileTransfers = undefined;
  for (const name of ["pdmux:desktop:action", "pdmux:local-agent:status", "pdmux:local-agent:retry", "pdmux:preferences:read", "pdmux:preferences:save"]) ipcMain.removeHandler(name);
  runtimeStop = Promise.resolve(transfers?.close())
    .finally(() => agent?.stop())
    .finally(() => running?.stop())
    .finally(() => { runtimeStop = undefined; });
  return runtimeStop;
}

function runtimeLayout(userData: string): RuntimeLayout {
  const root = app.isPackaged ? process.resourcesPath : resolve(moduleDirectory, "../../..");
  const dataDirectory = join(userData, "runtime");
  return {
    bunExecutable: app.isPackaged
      ? join(process.resourcesPath, "bin", process.platform === "win32" ? "bun.exe" : "bun")
      : process.env.PDMUX_BUN_EXECUTABLE ?? "bun",
    apiEntry: join(root, app.isPackaged ? "api/main.js" : "apps/api/dist-desktop/main.js"),
    migrateEntry: join(root, app.isPackaged ? "api/desktop-migrate.js" : "apps/api/dist-desktop/desktop-migrate.js"),
    webEntry: join(root, app.isPackaged ? "web/index.js" : "apps/web/build-desktop/index.js"),
    dataDirectory,
    filesDirectory: join(dataDirectory, "files"),
    databasePath: join(dataDirectory, "pdmux.sqlite"),
    secretPath: join(dataDirectory, "auth.secret"),
    agentReleaseDirectory: !app.isPackaged && process.env.PDMUX_DESKTOP_AGENT_RELEASE_DIR ? resolve(process.env.PDMUX_DESKTOP_AGENT_RELEASE_DIR) : join(root, app.isPackaged ? "web/client/agent" : "apps/web/build-desktop/client/agent"),
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
    title: "PDMux",
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"),
      additionalArguments: stack ? ["--pdmux-local-runtime=1"] : [],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      plugins: true,
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

async function authenticateLocal(webUrl: string, userData: string): Promise<string | undefined> {
  if (!stack) return;
  const profiles = await stack.profiles();
  let profileId: string | undefined;
  const selectionPath = join(userData, "local-profile.json");
  try {
    const saved: unknown = JSON.parse(await readFile(selectionPath, "utf8"));
    if (saved && typeof saved === "object" && "profileId" in saved && typeof saved.profileId === "string" && profiles.some(row => row.id === saved.profileId)) profileId = saved.profileId;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!profileId && profiles.length > 1) {
    const chosen = await dialog.showMessageBox({
      title: "PDMux", message: desktopMessages(app.getLocale()).selectProfile,
      buttons: profiles.map(row => `${row.name} (${row.email})`), noLink: true,
    });
    profileId = profiles[chosen.response]?.id;
    if (!profileId) throw new Error("No local profile selected");
  }
  const response = await stack.localSession(profileId);
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    await session.defaultSession.cookies.set({ url: webUrl, name: pair.slice(0, separator), value: pair.slice(separator + 1), httpOnly: true, sameSite: "lax" });
  }
  await stack.control("attach");
  const result = await response.json() as { profileId: string };
  await writeFile(selectionPath, JSON.stringify(result), { mode: 0o600 });
  return result.profileId;
}

async function initialize(): Promise<void> {
  const userData = app.getPath("userData");
  const config = await loadDesktopConfig(join(userData, "desktop.json"));
  const messages = desktopMessages(app.getLocale());
  const layout = runtimeLayout(userData);
  const backup = backupService(layout, config.mode === "local" ? config.backupRetention : 5);
  let appUrl: string;
  let localProfileId: string | undefined;

  if (config.mode === "local") {
    try { await stat(layout.databasePath); await backup.create("update"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    stack = new StackManager(layout, {}, (name, code) => {
      logError("Handle desktop runtime exit", "Desktop runtime exited unexpectedly", { name, code });
      if (quitting || restartAttempts >= 3) {
        void dialog.showErrorBox("PDMux", messages.runtimeFailed);
        return;
      }
      const delay = 1_000 * 2 ** restartAttempts;
      restartAttempts += 1;
      setTimeout(() => {
        void stack?.restart().then(async ({ webUrl }) => {
          await authenticateLocal(webUrl, userData);
          appUrl = webUrl;
          await localAgent?.start();
          fileTransfers?.setAppUrl(webUrl);
          await cloud?.setAppUrl(webUrl);
          return mainWindow?.loadURL(webUrl);
        }).catch((error: unknown) => {
          logError("Restart desktop runtime", error);
        });
      }, delay);
    });
    appUrl = (await stack.start()).webUrl;
    localProfileId = await authenticateLocal(appUrl, userData);
    if (localProfileId) {
      localAgent = new LocalAgent(stack, layout, localProfileId);
      await localAgent.start();
    }
  } else {
    appUrl = config.url;
    configureRemoteCertificatePin(config);
  }

  const window = secureWindow(appUrl);
  mainWindow = window;
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    isAllowedFontPermission(permission, Boolean(stack), contents === window.webContents, details.isMainFrame, details.requestingUrl, appUrl));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(isAllowedFontPermission(permission, Boolean(stack), contents === window.webContents, details.isMainFrame, details.requestingUrl, appUrl)));
  fileTransfers = new DesktopFileTransfers(window, session.defaultSession, appUrl, userData);
  await fileTransfers.initialize();
  if (stack && localProfileId) { cloud = new CloudConnection(window, stack, appUrl, userData, localProfileId, () => backup.create("manual"), config.mode === "local" ? config.serverUrl : config.url); await cloud.initialize(); }
  if (pendingDeepLink) { await cloud?.handleUrl(pendingDeepLink); pendingDeepLink = undefined; }
  window.on("close", (event) => {
    if (quitting || !config.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  const updateBackup = config.mode === "local"
    ? backup
    : { create: (_reason: "update"): Promise<string> => Promise.resolve(userData) };
  const updateWindow = new UpdateWindow(window, messages, error => logError("Show desktop update progress", error));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const updater = new UpdateCoordinator(app.isPackaged, autoUpdater, updateBackup, async () => {
    window.show();
    const result = await dialog.showMessageBox(window, {
      type: "info",
      message: messages.updateReady,
      buttons: [messages.updateInstall, messages.updateLater],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response === 0;
  }, async () => {
    // Squirrel.Mac closes windows before before-quit, so disable close-to-tray first.
    quitting = true;
    await stopRuntime();
  }, updateWindow);
  const requireSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== new URL(appUrl).origin) throw new Error("Desktop origin required");
  };
  if (stack) {
    const preferences = new TerminalPreferencesFile(join(userData, "terminal-preferences.json"));
    ipcMain.handle("pdmux:preferences:read", event => { requireSender(event); return preferences.read(); });
    ipcMain.handle("pdmux:preferences:save", (event, value: unknown) => { requireSender(event); return preferences.save(value); });
    ipcMain.handle("pdmux:desktop:action", async (event, action: unknown) => {
      requireSender(event);
      if (action === "backup") { const path = await backup.create("manual"); await dialog.showMessageBox(window, { message: messages.backupComplete, detail: path }); }
      else if (action === "open-data") { const error = await shell.openPath(userData); if (error) throw new Error("Cannot open desktop data"); }
      else if (action === "check-updates") await updater.check(true).catch(error => logError("Check desktop update", error));
      else throw new Error("Unknown desktop action");
    });
    ipcMain.handle("pdmux:local-agent:status", event => { requireSender(event); return localAgent?.status(); });
    ipcMain.handle("pdmux:local-agent:retry", async event => { requireSender(event); await localAgent?.start(true); return localAgent?.status(); });
  }
  autoUpdater.on("error", (error: Error) => logError("Update desktop application", error));
  autoUpdater.on("download-progress", progress => updater.progress(progress));

  const icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : resolve(moduleDirectory, "../resources"), "tray.png"));
  if (icon.isEmpty()) throw new Error("Desktop tray image is missing");
  const traySize = process.platform === "darwin" ? 20 : 24;
  tray = new Tray(icon.resize({ width: traySize, height: traySize }));
  tray.setToolTip("PDMux");
  tray.on("double-click", () => mainWindow?.show());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: messages.show, click: () => mainWindow?.show() },
    ...(config.mode === "local" ? [{ label: messages.settings, click: () => { mainWindow?.show(); window.webContents.send("pdmux:settings:open"); } }] : []),
    { label: messages.checkUpdates, click: () => { void updater.check(true).catch((error: unknown) => logError("Check desktop update", error)); } },
    { type: "separator" },
    { label: messages.quit, click: () => { quitting = true; app.quit(); } },
  ]));
  await window.loadURL(localAgent?.status().phase === "failed" ? new URL("/connection", appUrl).href : appUrl);
  void updater.check().catch((error: unknown) => logError("Check desktop update", error));
}

// Keep the legacy profile location when changing the visible application name.
app.setPath("userData", join(app.getPath("appData"), "pdmux-desktop"));
app.setName("PDMux");
const profile = userDataDirectory(process.argv);
if (profile) {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath("userData", profile);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDesktopProtocol();
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (cloud) void cloud.handleUrl(url).catch(() => logError("Authenticate desktop connection", "Authorization failed"));
    else pendingDeepLink = url;
  });
  app.on("second-instance", (_event, args) => {
    const url = args.find(value => value.startsWith("dev.podosoft.pdmux:/"));
    if (url) void cloud?.handleUrl(url).catch(() => logError("Authenticate desktop connection", "Authorization failed"));
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on("activate", () => mainWindow?.show());
  app.on("before-quit", (event) => {
    quitting = true;
    if (!stack && !fileTransfers && !localAgent && !runtimeStop) return;
    event.preventDefault();
    void stopRuntime()
      .catch((error: unknown) => logError("Stop desktop runtime", error))
      .finally(() => app.quit());
  });
  void app.whenReady().then(initialize).catch((error: unknown) => {
    logError("Initialize desktop application", error);
    dialog.showErrorBox("PDMux", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}
