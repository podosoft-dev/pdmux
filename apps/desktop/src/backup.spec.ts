import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupService } from "./backup.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("[TC-PDDESKTOP-007] desktop backups", () => {
  it("publishes complete snapshots and prunes old generations", async () => {
    root = await mkdtemp(join(tmpdir(), "pdmux-backup-"));
    const databasePath = join(root, "pdmux.sqlite");
    const filesDirectory = join(root, "files");
    const backupsDirectory = join(root, "backups");
    await mkdir(filesDirectory);
    await writeFile(databasePath, "database");
    await writeFile(join(filesDirectory, "object.txt"), "object");
    const dates = [
      new Date("2026-09-04T10:00:00.000Z"),
      new Date("2026-09-04T11:00:00.000Z"),
      new Date("2026-09-04T12:00:00.000Z"),
    ];
    const service = new BackupService({
      databasePath,
      filesDirectory,
      backupsDirectory,
      bunExecutable: "/runtime/bun",
      sqliteBackupScript: "/runtime/sqlite-backup.mjs",
    }, 2, {
      copyDatabase: (source, destination) => cp(source, destination),
      now: () => dates.shift() ?? new Date("2026-09-04T12:00:00.000Z"),
    });

    await service.create("manual");
    await service.create("startup");
    const latest = await service.create("update");
    const generations = (await readdir(backupsDirectory)).filter((name) => !name.startsWith("."));
    expect(generations).toHaveLength(2);
    expect(await readFile(join(latest, "pdmux.sqlite"), "utf8")).toBe("database");
    expect(await readFile(join(latest, "files", "object.txt"), "utf8")).toBe("object");
  });
});
