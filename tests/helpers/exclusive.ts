import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Locks for server-wide settings that specs in more than one file change. The
// suite runs on one worker by default; with --workers above 1, specs of the api
// and ui projects run at the same time, and two that flip the same setting
// would undo each other mid-test:
//
// - `require2fa`, `magic-link`, `oidc-provider`: feature flags
// - `session-idle-timeout`: automatic logout in the auth configuration
// - `social-providers`: any social sign-in provider in the auth configuration
// - `site-general`: the General settings form, which saves all of its fields
//   (name, footer, locale, maintenance mode, public sign-up, ...) at once
// - `site-theme`: the Appearance settings
//
// A spec that holds a lock calls `test.slow()`, since waiting for another
// holder counts against its timeout.

// Longer than any spec holds a lock. A lock whose holder process has exited is
// taken over at once; this bounds the wait when the holder cannot be checked.
const STALE_MS = 120_000;
const OWNER_FILE = "owner";

/** The lock directory for `name`, shared by every worker on this machine. */
export function lockPath(name: string): string {
  return join(tmpdir(), `podokit-e2e-${name}.lock`);
}

/** Whether the worker that holds `lock` has exited, such as after Ctrl-C. */
async function holderExited(lock: string): Promise<boolean> {
  const pid = Number(await readFile(join(lock, OWNER_FILE), "utf8").catch(() => ""));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function acquire(lock: string): Promise<void> {
  for (;;) {
    const created = await mkdir(lock).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      },
    );
    if (created) {
      await writeFile(join(lock, OWNER_FILE), String(process.pid)).catch(async (error: unknown) => {
        await rm(lock, { recursive: true, force: true });
        throw error;
      });
      return;
    }
    const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (age > STALE_MS || (await holderExited(lock))) await rm(lock, { recursive: true, force: true });
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Runs `body` while no other Playwright worker on this machine holds any of
 *  the named locks, and releases them however `body` ends. */
export async function exclusive<T>(names: string | string[], body: () => Promise<T>): Promise<T> {
  // One acquisition order for every caller, so two specs that each need
  // several locks cannot wait on each other.
  const locks = [...new Set([names].flat())].sort().map(lockPath);
  const held: string[] = [];
  try {
    for (const lock of locks) {
      await acquire(lock);
      held.push(lock);
    }
    return await body();
  } finally {
    for (const lock of held.reverse()) await rm(lock, { recursive: true, force: true });
  }
}
