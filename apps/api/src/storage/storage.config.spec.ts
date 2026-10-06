import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { storageSettings } from "./storage.config";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe("storageSettings", () => {
  it("uses path-style MinIO settings by default", () => {
    process.env.STORAGE_PROVIDER = "minio";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    expect(storageSettings()).toMatchObject({
      provider: "minio",
      endpoint: "http://localhost:9000",
      virtualHostedStyle: false,
    });
  });
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a configuration object");
  }
  return value as Record<string, unknown>;
}

function repositoryFile(relativePath: string): string {
  for (const root of [process.cwd(), resolve(process.cwd(), "../..")]) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Repository file not found: ${relativePath}`);
}

describe("[TC-PDHOST-031] bundled S3-compatible storage", () => {
  const release = "RELEASE.2026-09-16T00-00-00Z";
  const configurations = [
    { path: "compose.dev.yaml", volume: "miniodata" },
    { path: "infra/docker/minio.compose.yml", volume: "minio-data" },
    { path: "infra/docker/selfhost.compose.yml", volume: "minio" },
  ];

  for (const { path, volume } of configurations) {
    it(`pins Silo and its client while preserving the storage contract in ${path}`, () => {
      const configuration = record(Bun.YAML.parse(readFileSync(repositoryFile(path), "utf8")));
      const services = record(configuration.services);
      const storage = record(services.minio);
      const initializer = record(services["minio-init"]);
      expect(storage.image).toBe(`pgsty/silo:${release}`);
      expect(initializer.image).toBe(`pgsty/mc:${release}`);
      expect(storage.volumes).toEqual([`${volume}:/data`]);
      expect(record(configuration.volumes)).toHaveProperty(volume);
      expect(record(storage.environment)).toHaveProperty("MINIO_ROOT_USER");
      expect(record(storage.environment)).toHaveProperty("MINIO_ROOT_PASSWORD");
      const entrypoint = Array.isArray(initializer.entrypoint)
        ? initializer.entrypoint.join(" ")
        : String(initializer.entrypoint);
      expect(entrypoint).toContain("http://minio:9000");
      expect(entrypoint).toContain("mc alias set");
      expect(entrypoint).toContain("mc mb");
      if (path.endsWith("selfhost.compose.yml")) {
        expect(record(record(services.migrate).environment)).toMatchObject({
          STORAGE_PROVIDER: "minio",
          S3_ENDPOINT: "http://minio:9000",
          S3_FORCE_PATH_STYLE: "true",
        });
      }
    });
  }
});
