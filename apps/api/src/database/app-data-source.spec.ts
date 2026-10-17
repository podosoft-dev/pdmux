import { describe, expect, it } from "bun:test";
import { DataSource, type DataSourceOptions } from "typeorm";
import { validateEnv } from "../config/env.validation";
import { createDataSourceOptions } from "./app-data-source";
import { applicationDataSourceOptions } from "./application-database";

type PoolConfig = Record<string, unknown>;

/**
 * The configuration TypeORM's postgres driver gives the pg pool it opens for
 * `options`, recorded by a stand-in Pool so no server is needed. TypeORM merges
 * `poolSize` and `extra` itself, so this is the `max` pg would enforce.
 */
async function openedPool(options: DataSourceOptions): Promise<PoolConfig> {
  const opened: PoolConfig[] = [];
  class RecordingPool {
    constructor(config: PoolConfig) {
      opened.push(config);
    }
    on(): void {}
    connect(callback: (error: undefined, client: { on(): void }, release: () => void) => void): void {
      callback(undefined, { on: () => undefined }, () => undefined);
    }
  }
  const dataSource = new DataSource({ ...options, driver: { Pool: RecordingPool } } as DataSourceOptions);
  const createPool: unknown = Reflect.get(dataSource.driver, "createPool");
  if (typeof createPool !== "function") throw new Error("TypeORM's postgres driver has no createPool");
  await Reflect.apply(createPool, dataSource.driver, [dataSource.options, dataSource.options]);
  const [config] = opened;
  if (!config || opened.length !== 1) throw new Error(`TypeORM opened ${opened.length} pools`);
  return config;
}

describe("pdmux TypeORM pool size", () => {
  it("caps the pool the API and the worker open at 10 connections by default", async () => {
    const worker = createDataSourceOptions({});
    const api = applicationDataSourceOptions(createDataSourceOptions({}), validateEnv({}));
    expect(worker).toMatchObject({ type: "postgres", poolSize: 10 });
    expect((await openedPool(worker)).max).toBe(10);
    expect((await openedPool(api)).max).toBe(10);
  });

  it("takes the cap from PDMUX_DB_POOL_MAX, which a deployment profile counts", async () => {
    const env = { PDMUX_DB_POOL_MAX: "4" };
    expect((await openedPool(createDataSourceOptions(env))).max).toBe(4);
    expect((await openedPool(applicationDataSourceOptions(createDataSourceOptions(env), validateEnv(env)))).max)
      .toBe(4);
  });

  it("refuses a cap that is not a positive whole number", () => {
    expect(() => createDataSourceOptions({ PDMUX_DB_POOL_MAX: "0" })).toThrow("PDMUX_DB_POOL_MAX");
    expect(() => createDataSourceOptions({ PDMUX_DB_POOL_MAX: "2.5" })).toThrow("PDMUX_DB_POOL_MAX");
  });
});
