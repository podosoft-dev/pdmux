import { visibleWindowsConsoles, assertNoRuntimeConsoles, windowsRuntimeChildren } from "./windows-background.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { verifyDesktopFirstRun } from "./desktop-first-run.mjs";
import { verifyDesktopNavigation } from "./desktop-navigation.mjs";
import { desktopPaths } from "./desktop-package-paths.mjs";
import { join, relative, resolve, sep } from "node:path";
import { _electron as electron } from "playwright";

// Launch only a real package on a disposable verification VM, never a live desktop.
const local = process.env.PDMUX_LOCAL_DESKTOP_SMOKE === "1";
if (!local) {
  assert.ok(process.env.GITHUB_ACTIONS === "true" || process.platform === "linux", "Non-Linux runs require a disposable CI runner");
  if (process.platform !== "linux") assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Do not run native smoke tests on shared desktops");
} else assert.notEqual(process.env.GITHUB_ACTIONS, "true", "CI must use its hosted-runner boundary");
const bundle = resolve(process.argv[2]);
const screenshot = resolve(process.argv[3]);
const paths = desktopPaths(bundle, process.platform);
const configuration = process.env.PDMUX_SMOKE_CONFIG_ROOT ?? await mkdtemp(join(tmpdir(), "pdmux-desktop-smoke-"));
const relativeProfile = relative(tmpdir(), resolve(configuration));
assert.ok(!relativeProfile.startsWith("..") && relativeProfile.split(sep)[0].startsWith("pdmux-"), "Smoke profiles must live in a pdmux temporary directory");
const tmuxDirectory = join(configuration, "tmux"); await mkdir(tmuxDirectory, { recursive: true });
const baselineConsoles = visibleWindowsConsoles();
const application = await electron.launch({
  executablePath: paths.executable, timeout: 120_000, chromiumSandbox: true,
  args: [`--user-data-dir=${resolve(configuration)}`],
  env: { ...process.env, TMUX: "", TMUX_TMPDIR: tmuxDirectory, ...(process.platform === "linux" ? { XDG_CONFIG_HOME: configuration } : {}) },
});
let window;
try {
  assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), resolve(configuration), "Isolate the real user's desktop data");
  window = await application.firstWindow({ timeout: 120_000 });
  await window.waitForURL(/http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  await window.locator('[data-testid="shell-user"]').waitFor({ timeout: 60_000 });
  assert.ok(!new URL(window.url()).pathname.startsWith("/login"), "Open the local workspace without login");
  // Functions cannot cross Playwright's serialization boundary. Inspect them
  // inside the renderer and return only their names and types.
  assert.deepEqual(await window.evaluate(() => ({
    isDesktop: window.pdmuxDesktop?.isDesktop,
    platform: window.pdmuxDesktop?.platform,
    transfers: Object.fromEntries(Object.entries(window.pdmuxDesktop?.transfers ?? {}).map(([name, method]) => [name, typeof method])),
  })), {
    isDesktop: true, platform: process.platform,
    transfers: { pickFolder: "function", read: "function", release: "function", download: "function",
      status: "function", pauseDownload: "function", cancelDownload: "function" },
  });
  assert.ok((await window.locator("body").innerText()).length > 30, "Render the local workspace");
  await verifyDesktopFirstRun(window, `${screenshot}.menu.png`, { fresh: !process.argv.includes("--expect-preserved") });
  await verifyDesktopNavigation(window, `${screenshot}.navigation`);
  if (process.platform === "win32") {
    assertNoRuntimeConsoles(baselineConsoles);
    // Playwright launches Electron through cmd.exe on Windows. Its process() PID
    // belongs to that launcher; inspect the actual Electron main process instead.
    const mainPid = await application.evaluate(() => process.pid);
    const children = windowsRuntimeChildren(mainPid);
    assert.equal(children.length, 2, "Require both embedded runtime processes");
    const priorUrl = window.url();
    process.kill(children[0]);
    await window.waitForURL(url => url.href !== priorUrl, { timeout: 90_000 });
    await window.waitForFunction(async () => (await window.pdmuxDesktop.localAgent.status()).phase === "ready");
    assert.equal(windowsRuntimeChildren(mainPid).length, 2);
    assertNoRuntimeConsoles(baselineConsoles);
    console.log(JSON.stringify({ stage: "windows-background-recovery", result: "passed" }));
  }

  await application.evaluate(async ({ app, dialog }) => {
    const { join } = process.getBuiltinModule("node:path");
    const { mkdir, writeFile } = process.getBuiltinModule("node:fs/promises");
    const folder = join(app.getPath("userData"), "native-transfer-fixture");
    await mkdir(join(folder, "empty"), { recursive: true });
    await writeFile(join(folder, "file.txt"), "native-folder-transfer");
    // Automate only the OS chooser's returned selection. Preload, IPC, scoped
    // filesystem traversal, bounded reads and token revocation are the real app.
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [folder] };
    };
  });
  const source = await window.evaluate(async () => {
    const transfers = window.pdmuxDesktop.transfers;
    const selected = await transfers.pickFolder();
    if (!selected) throw new Error("Missing native selection");
    const entry = selected.entries.find(row => row.path.endsWith("/file.txt"));
    const bytes = await transfers.read(selected.token, entry.path, 0, entry.size);
    await transfers.release(selected.token);
    let revoked = false;
    try { await transfers.read(selected.token, entry.path, 0, entry.size); }
    catch { revoked = true; }
    return { content: new TextDecoder().decode(bytes), empty: selected.entries.some(row => row.kind === "directory" && row.path.endsWith("/empty")), revoked };
  });
  assert.deepEqual(source, { content: "native-folder-transfer", empty: true, revoked: true });
  const result = await application.evaluate(async ({ app }) => {
    // Inspector evaluation has no dynamic-import callback. Use Node's supported
    // builtin lookup and a package-scoped require for the synchronous ESM module.
    const { join } = process.getBuiltinModule("node:path");
    const { readFile, writeFile } = process.getBuiltinModule("node:fs/promises");
    const { createHash } = process.getBuiltinModule("node:crypto");
    const require = process.getBuiltinModule("node:module").createRequire(join(app.getAppPath(), "package.json"));
    const data = app.getPath("userData");
    const runtime = join(data, "runtime");
    const sentinel = join(runtime, "files", "release-verification.txt");
    let prior = false;
    try { prior = (await readFile(sentinel, "utf8")) === "preserve-release-data"; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(sentinel, "preserve-release-data");
    // Exercise the packaged backup module and helper against the running SQLite DB.
    const { BackupService } = require("./dist/backup.js");
    const backup = new BackupService({
      databasePath: join(runtime, "pdmux.sqlite"), filesDirectory: join(runtime, "files"),
      backupsDirectory: join(data, "backups"), bunExecutable: join(process.resourcesPath, "bin", process.platform === "win32" ? "bun.exe" : "bun"),
      sqliteBackupScript: join(process.resourcesPath, "runtime/sqlite-backup.mjs"),
    }, 5);
    const backupPath = await backup.create("update");
    if ((await readFile(join(backupPath, "files/release-verification.txt"), "utf8")) !== "preserve-release-data") throw new Error("Backup lost uploaded files");
    return { data, backupPath, prior, version: app.getVersion(), secretHash: createHash("sha256").update(await readFile(join(runtime, "auth.secret"))).digest("hex") };
  });
  const bun = paths.bun;
  const check = 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify({integrity:db.query("pragma integrity_check").get().integrity_check,tables:db.query("select count(*) as n from sqlite_master where type=\x27table\x27").get().n})); db.close();';
  const database = JSON.parse(execFileSync(bun, ["-e", check, join(result.backupPath, "pdmux.sqlite")], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(database.integrity, "ok");
  assert.ok(database.tables > 10, "Require migrated application and authentication tables");
  const expected = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8")).version;
  assert.equal(result.version, expected);
  const preservation = join(result.data, "release-verification-auth-sha256");
  if (process.argv.includes("--expect-preserved")) {
    assert.ok(result.prior, "Preserve data across package replacement and restart");
    assert.equal(await readFile(preservation, "utf8"), result.secretHash, "Preserve the encryption key across package replacement");
  } else await writeFile(preservation, result.secretHash, { mode: 0o600 });
  console.log(JSON.stringify({ stage: "packaged-desktop-runtime", version: result.version, dataPreserved: result.prior, database, result: "passed" }));
} finally {
  if (window && !window.isClosed()) {
    console.log(JSON.stringify({ stage: "desktop-window", url: window.url(), title: await window.title() }));
    await window.screenshot({ path: screenshot });
  }
  await application.close();
  if (!process.env.PDMUX_SMOKE_CONFIG_ROOT) await rm(configuration, { recursive: true, force: true });
}
