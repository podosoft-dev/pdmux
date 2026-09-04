import { afterEach, describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { SQL } from "bun";
import { UserLayout } from "../prefs/user-layout.entity";
import { initializeDesktopSchema } from "./desktop-schema";
import { createAppDataSource, createDataSourceOptions, entityTypes } from "./data-source";

let source: DataSource | undefined;

afterEach(async () => {
  if (source?.isInitialized) await source.destroy();
  source = undefined;
});

describe("[TC-PDDESKTOP-002] Bun SQLite TypeORM compatibility", () => {
  it("initializes every application entity and round-trips JSON and dates", async () => {
    const options = createDataSourceOptions({
      PDMUX_DESKTOP: "1",
      DATABASE_URL: "sqlite://:memory:",
    });
    source = createAppDataSource(options);
    await source.initialize();

    expect(source.entityMetadatas).toHaveLength(entityTypes.length);
    const repository = source.getRepository(UserLayout);
    const saved = await repository.save(repository.create({
      userId: "user-1",
      name: "desktop",
      isDefault: true,
      payload: { columns: 2, widgets: ["terminal", "metrics"] },
    }));
    const loaded = await repository.findOneByOrFail({ id: saved.id });

    expect(loaded.payload).toEqual({ columns: 2, widgets: ["terminal", "metrics"] });
    expect(loaded.createdAt).toBeInstanceOf(Date);
    expect(loaded.updatedAt).toBeInstanceOf(Date);
  });

  it("initializes provider-independent settings, auth config, and audit tables", async () => {
    const sql = new SQL("sqlite://:memory:", {
      adapter: "sqlite",
      create: true,
      readwrite: true,
      strict: true,
    });
    try {
      await initializeDesktopSchema(sql);
      await initializeDesktopSchema(sql);
      const settings = await sql<Array<{ key: string }>>`SELECT "key" FROM "app_setting"`;
      const tables = await sql<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_master"
        WHERE "type" = 'table' AND "name" IN ('app_setting', 'auth_config', 'audit_logs')
      `;
      expect(settings.length).toBeGreaterThan(0);
      expect(tables.map((row) => row.name).sort()).toEqual([
        "app_setting",
        "audit_logs",
        "auth_config",
      ]);
    } finally {
      await sql.close();
    }
  });
});
