import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

const fingerprint = z.string().transform((value) => value.replaceAll(":", "").toUpperCase())
  .pipe(z.string().regex(/^[A-F0-9]{64}$/, "Certificate pins must be SHA-256 fingerprints"));

const localConfig = z.object({
  mode: z.literal("local"),
  closeToTray: z.boolean().default(true),
  backupRetention: z.number().int().min(1).max(100).default(5),
}).strict();

const remoteConfig = z.object({
  mode: z.literal("remote"),
  url: z.string().url().refine((value) => new URL(value).protocol === "https:", "Remote URL must use HTTPS"),
  certificatePins: z.array(fingerprint).min(1),
  closeToTray: z.boolean().default(true),
}).strict();

export type LocalDesktopConfig = z.infer<typeof localConfig>;
export type RemoteDesktopConfig = z.infer<typeof remoteConfig>;
export type DesktopConfig = LocalDesktopConfig | RemoteDesktopConfig;

export const DEFAULT_DESKTOP_CONFIG: LocalDesktopConfig = {
  mode: "local",
  closeToTray: true,
  backupRetention: 5,
};

export function parseDesktopConfig(value: unknown): DesktopConfig {
  if (value === undefined || value === null) return { ...DEFAULT_DESKTOP_CONFIG };
  return z.discriminatedUnion("mode", [localConfig, remoteConfig]).parse(value);
}

export async function loadDesktopConfig(path: string): Promise<DesktopConfig> {
  try {
    return parseDesktopConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ...DEFAULT_DESKTOP_CONFIG };
    }
    throw error;
  }
}

export async function saveDesktopConfig(path: string, config: DesktopConfig): Promise<void> {
  const validated = parseDesktopConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.desktop-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
