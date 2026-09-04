import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface BackupLayout {
  databasePath: string;
  filesDirectory: string;
  backupsDirectory: string;
  bunExecutable: string;
  sqliteBackupScript: string;
}

export interface BackupDependencies {
  copyDatabase: (source: string, destination: string) => Promise<void>;
  now: () => Date;
}

function runDatabaseCopy(
  executable: string,
  script: string,
  source: string,
  destination: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script, source, destination], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`SQLite backup exited with code ${code}`)));
  });
}

function backupName(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

export class BackupService {
  private readonly dependencies: BackupDependencies;

  constructor(private readonly layout: BackupLayout, private readonly retention: number, dependencies: Partial<BackupDependencies> = {}) {
    if (!Number.isInteger(retention) || retention < 1) throw new Error("Backup retention must be positive");
    this.dependencies = {
      copyDatabase: (source, destination) => runDatabaseCopy(
        layout.bunExecutable,
        layout.sqliteBackupScript,
        source,
        destination,
      ),
      now: () => new Date(),
      ...dependencies,
    };
  }

  async create(reason: "manual" | "update" | "startup" = "manual"): Promise<string> {
    await mkdir(this.layout.backupsDirectory, { recursive: true, mode: 0o700 });
    const createdAt = this.dependencies.now();
    const name = backupName(createdAt);
    const finalDirectory = join(this.layout.backupsDirectory, name);
    const temporaryDirectory = join(this.layout.backupsDirectory, `.${name}-${crypto.randomUUID()}.tmp`);
    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
      await this.dependencies.copyDatabase(
        this.layout.databasePath,
        join(temporaryDirectory, "pdmux.sqlite"),
      );
      await cp(this.layout.filesDirectory, join(temporaryDirectory, "files"), {
        recursive: true,
        force: false,
        errorOnExist: true,
      }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
      await writeFile(join(temporaryDirectory, "manifest.json"), `${JSON.stringify({
        format: 1,
        createdAt: createdAt.toISOString(),
        reason,
        database: basename(this.layout.databasePath),
      }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryDirectory, finalDirectory);
      await this.prune();
      return finalDirectory;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.layout.backupsDirectory, { withFileTypes: true });
    const generations = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    await Promise.all(
      generations.slice(this.retention).map((name) =>
        rm(join(this.layout.backupsDirectory, name), { recursive: true, force: true })
      ),
    );
  }
}
