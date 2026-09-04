import { Database as BunDatabase, type SQLQueryBindings, type Statement } from "bun:sqlite";
import {
  type ColumnType,
  DataSource,
  type TableColumn,
} from "typeorm";
import { BetterSqlite3Driver } from "typeorm/driver/better-sqlite3/BetterSqlite3Driver.js";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata.js";

interface DatabaseOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
}

interface StatementResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

function binding(value: unknown): SQLQueryBindings {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    ArrayBuffer.isView(value)
  ) return ArrayBuffer.isView(value) ? value as NodeJS.TypedArray : value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, string | bigint | NodeJS.TypedArray | number | boolean | null>;
  }
  throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
}

class BunStatementAdapter {
  readonly reader: boolean;

  constructor(private readonly statement: Statement<Record<string, unknown>, SQLQueryBindings[]>) {
    this.reader = statement.columnNames.length > 0;
  }

  all(...parameters: unknown[]): Record<string, unknown>[] {
    return this.statement.all(...parameters.map(binding));
  }

  run(...parameters: unknown[]): StatementResult {
    return this.statement.run(...parameters.map(binding));
  }
}

/** Exposes Bun's built-in SQLite implementation through the small synchronous
 * surface TypeORM's better-sqlite3 query runner expects. */
export class BunSqliteDatabaseAdapter {
  private readonly database: BunDatabase;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.database = new BunDatabase(path, {
      readonly: options.readonly ?? false,
      create: !(options.readonly || options.fileMustExist),
      strict: true,
    });
    if (options.timeout !== undefined) this.database.run(`PRAGMA busy_timeout = ${options.timeout}`);
  }

  prepare(query: string): BunStatementAdapter {
    return new BunStatementAdapter(
      this.database.prepare<Record<string, unknown>, SQLQueryBindings[]>(query),
    );
  }

  pragma(source: string): Record<string, unknown>[] {
    return this.database.query<Record<string, unknown>, []>(`PRAGMA ${source}`).all();
  }

  close(): void {
    this.database.close();
  }
}

function sqliteDate(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function hydratedDate(value: unknown): unknown {
  if (value instanceof Date || typeof value === "number") return new Date(value);
  if (typeof value !== "string") return value;
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return new Date(normalized);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

/** Keeps PostgreSQL entity metadata as the server source of truth while mapping
 * its JSONB, timestamptz, and array storage to portable SQLite columns. */
export class PdmuxSqliteDriver extends BetterSqlite3Driver {
  constructor(connection: DataSource) {
    super(connection);
    this.supportedDataTypes.push("jsonb", "timestamptz");
  }

  override normalizeType(column: {
    type?: ColumnType;
    length?: number | string;
    precision?: number | null;
    scale?: number;
  }): string {
    if (column.type === "jsonb") return "text";
    if (column.type === "timestamptz") return "datetime";
    return super.normalizeType(column);
  }

  override createFullType(column: TableColumn): string {
    if (column.isGenerated && column.generationStrategy === "increment") return "integer";
    if (column.isArray || column.type === "jsonb") return "text";
    if (column.type === "timestamptz") return "datetime";
    return super.createFullType(column);
  }

  override preparePersistentValue(value: unknown, columnMetadata: ColumnMetadata): unknown {
    if (value === null || value === undefined) return value;
    if (columnMetadata.isArray || columnMetadata.type === "jsonb") return JSON.stringify(value);
    if (columnMetadata.type === "timestamptz") return sqliteDate(value);
    return super.preparePersistentValue(value, columnMetadata);
  }

  override prepareHydratedValue(value: unknown, columnMetadata: ColumnMetadata): unknown {
    if (value === null || value === undefined) return value;
    if (columnMetadata.isArray || columnMetadata.type === "jsonb") return parsedJson(value);
    if (columnMetadata.type === "timestamptz") return hydratedDate(value);
    return super.prepareHydratedValue(value, columnMetadata);
  }

  override normalizeDefault(columnMetadata: ColumnMetadata): string | undefined {
    const raw = typeof columnMetadata.default === "function"
      ? columnMetadata.default()
      : columnMetadata.default;
    if (typeof raw === "string") {
      if (/^now\(\)$/i.test(raw)) return "CURRENT_TIMESTAMP";
      if (columnMetadata.isArray) {
        if (raw === "'{}'") return "'[]'";
        const entries = [...raw.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1]?.replaceAll("''", "'") ?? "");
        if (entries.length > 0) return `'${JSON.stringify(entries).replaceAll("'", "''")}'`;
      }
      if (columnMetadata.type === "jsonb") return raw.replace(/::jsonb$/i, "");
    }
    return super.normalizeDefault(columnMetadata);
  }
}

export function installPdmuxSqliteDriver(source: DataSource): DataSource {
  source.driver = new PdmuxSqliteDriver(source);
  return source;
}
