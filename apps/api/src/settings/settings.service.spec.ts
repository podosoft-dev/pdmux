import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { SQL } from "bun";
import { createConfigStore, type AppSettingRow, type ConfigVersions } from "@podosoft/podokit-auth";
import { SettingsService } from "./settings.service";

type Row = AppSettingRow & { updatedAt: number };

/** In-memory app_setting table with the same upsert semantics as the service's SQL. */
function table() {
  const rows = new Map<string, Row>();
  let clock = 1;
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [key, value] = values as [string, string];
    rows.set(key, { key, value, updatedAt: clock++ });
    return [];
  }) as unknown as SQL;
  const store = () => createConfigStore({
    list: async () => [],
    listSettings: async () => [...rows.values()].map(({ key, value }) => ({ key, value })),
    versions: async (): Promise<ConfigVersions> => ({
      authConfig: "0:",
      appSettings: `${rows.size}:${Math.max(0, ...[...rows.values()].map((row) => row.updatedAt))}`,
    }),
  });
  return { rows, sql, store };
}

describe("SettingsService", () => {
  let now = Date.UTC(2026, 0, 1);
  beforeEach(() => {
    now = Date.UTC(2026, 0, 1);
    setSystemTime(new Date(now));
  });
  afterEach(() => {
    setSystemTime();
  });

  test("applies a local write at once and reports the change", async () => {
    const { sql, store } = table();
    let changes = 0;
    const settings = new SettingsService(sql, store(), async () => {
      changes += 1;
    });
    expect(await settings.getBool("require2fa")).toBe(false);
    const flags = await settings.setMany({ require2fa: true });
    expect(flags.require2fa).toBe(true);
    expect(await settings.getBool("require2fa")).toBe(true);
    expect(changes).toBe(1);
  });

  test("follows another replica's write within the snapshot TTL", async () => {
    const { sql, store } = table();
    const replicaA = new SettingsService(sql, store());
    const replicaB = new SettingsService(sql, store());
    expect(await replicaB.getBool("require2fa")).toBe(false);

    await replicaA.setMany({ require2fa: true });
    expect(await replicaB.getBool("require2fa")).toBe(false);
    setSystemTime(new Date(now + 3_100));
    expect(await replicaB.getBool("require2fa")).toBe(true);
    expect((await replicaB.flags()).require2fa).toBe(true);
  });

  test("falls back to the shipped defaults when app_setting is unavailable", async () => {
    const settings = new SettingsService(table().sql, createConfigStore({
      list: async () => [],
      listSettings: async () => [],
      versions: async () => {
        throw new Error('relation "app_setting" does not exist');
      },
    }));
    expect(await settings.flags()).toMatchObject({ twoFactor: true, phoneNumber: false, require2fa: false });
  });

  test("returns a copy of the flags", async () => {
    const { sql, store } = table();
    const settings = new SettingsService(sql, store());
    (await settings.flags()).require2fa = true;
    expect(await settings.getBool("require2fa")).toBe(false);
  });
});
