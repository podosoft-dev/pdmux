import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

// Launch only a real package on a disposable verification VM, never a live desktop.
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "darwin");
const bundle = resolve(process.argv[2]);
const screenshot = resolve(process.argv[3]);
const application = await electron.launch({ executablePath: join(bundle, "Contents/MacOS/pdmux"), timeout: 120_000 });
let window;
try {
  window = await application.firstWindow({ timeout: 120_000 });
  await window.waitForURL(/http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  // Username sign-in uses type=text for the same email/username field.
  await window.locator('input#email[autocomplete="username"]').waitFor({ timeout: 60_000 });
  // Functions cannot cross Playwright's serialization boundary. Inspect them
  // inside the renderer and return only their names and types.
  assert.deepEqual(await window.evaluate(() => ({
    isDesktop: window.pdmuxDesktop?.isDesktop,
    platform: window.pdmuxDesktop?.platform,
    transfers: Object.fromEntries(Object.entries(window.pdmuxDesktop?.transfers ?? {}).map(([name, method]) => [name, typeof method])),
  })), {
    isDesktop: true, platform: "darwin",
    transfers: { pickFolder: "function", read: "function", release: "function", download: "function",
      status: "function", pauseDownload: "function", cancelDownload: "function" },
  });
  assert.ok((await window.locator("body").innerText()).length > 30, "Render the real login page");
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
      backupsDirectory: join(data, "backups"), bunExecutable: join(process.resourcesPath, "bin/bun"),
      sqliteBackupScript: join(process.resourcesPath, "runtime/sqlite-backup.mjs"),
    }, 5);
    const backupPath = await backup.create("update");
    if ((await readFile(join(backupPath, "files/release-verification.txt"), "utf8")) !== "preserve-release-data") throw new Error("Backup lost uploaded files");
    return { data, backupPath, prior, version: app.getVersion(), secretHash: createHash("sha256").update(await readFile(join(runtime, "auth.secret"))).digest("hex") };
  });
  const bun = join(bundle, "Contents/Resources/bin/bun");
  const check = 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify({integrity:db.query("pragma integrity_check").get().integrity_check,tables:db.query("select count(*) as n from sqlite_master where type=\x27table\x27").get().n})); db.close();';
  const database = JSON.parse(execFileSync(bun, ["-e", check, join(result.backupPath, "pdmux.sqlite")], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(database.integrity, "ok");
  assert.ok(database.tables > 10, "Require migrated application and authentication tables");
  const expected = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8")).version;
  assert.equal(result.version, expected);
  if (process.argv.includes("--expect-preserved")) assert.ok(result.prior, "Preserve data across package replacement and restart");
  console.log(JSON.stringify({ stage: "packaged-desktop-runtime", version: result.version, dataPreserved: result.prior, database, result: "passed" }));
} finally {
  if (window && !window.isClosed()) {
    console.log(JSON.stringify({ stage: "desktop-window", url: window.url(), title: await window.title() }));
    await window.screenshot({ path: screenshot });
  }
  await application.close();
}
