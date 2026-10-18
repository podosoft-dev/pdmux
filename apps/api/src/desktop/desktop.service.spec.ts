import { afterEach, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { createAppDataSource, createDataSourceOptions } from "../database/app-data-source";
import type { PdmuxServices } from "../pdmux/pdmux.services";
import { DesktopRecord } from "./desktop-record.entity";
import { DesktopService } from "./desktop.service";

let source: DataSource | undefined;
afterEach(async () => { if (source?.isInitialized) await source.destroy(); source = undefined; });

it("[TC-PDDESKTOP-012] caching a host view never writes back the rest of a stale binding", async () => {
  source = createAppDataSource(createDataSourceOptions({ DATABASE_PROVIDER: "sqlite", DATABASE_URL: "sqlite://:memory:" }));
  await source.initialize();
  const records = source.getRepository(DesktopRecord);
  const service = new DesktopService({} as PdmuxServices, records);
  await records.save(records.create({ id: "binding", scopeId: "org", userId: "user", key: "host:device:1", kind: "host", origin: "device",
    connectionKey: "", hostId: crypto.randomUUID(), value: { label: "before" }, cachedView: null }));
  // The host list read this row, then a sync stored a newer value while that read waited on the desktop.
  const stale = await records.findOneByOrFail({ id: "binding" });
  await records.update({ id: "binding" }, { value: { label: "after" } });
  await service.cacheView(stale, { label: "after", connected: true });
  const row = await records.findOneByOrFail({ id: "binding" });
  expect(row.value).toEqual({ label: "after" });
  expect(row.cachedView).toEqual({ label: "after", connected: true });
});
