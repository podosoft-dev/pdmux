import type { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import type { AuthSession } from "../auth/auth.service";
import { clientAddressOf } from "../core/client-address";
import { setAuditRecorder, type AuditEntry } from "./audit-events";

export interface AuditLogView extends AuditEntry {
  id: string;
  createdAt: string;
}

type AuditLogRow = Omit<AuditLogView, "createdAt" | "metadata"> & {
  createdAt: Date | string;
  metadata: unknown;
};

// A type alias, not an interface: Bun's insert helper needs an indexable row.
type AuditRow = {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | string | null;
  createdAt: string;
};

const COLUMNS = [
  "id", "action", "actorId", "actorName", "actorEmail",
  "targetType", "targetId", "targetLabel", "ip", "metadata", "createdAt",
] as const satisfies readonly (keyof AuditRow)[];

export const DEFAULT_AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 100;
const MAX_LISTED_ACTIONS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditLogQuery {
  /** Opaque position from a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
  /** Newest first by default. */
  order?: "asc" | "desc";
  /** Exact action code. */
  action?: string;
  /** Exact actor email. */
  actor?: string;
  /** Exact target label (the email or title the list shows). */
  target?: string;
}

export interface AuditLogPage {
  entries: AuditLogView[];
  /** Cursor for the following page; null on the last page. */
  nextCursor: string | null;
}

interface AuditPosition {
  createdAt: string;
  id: string;
}

export interface AuditTarget {
  type?: string;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditQueueOptions {
  /** Deferred entries held in memory; once full, new deferred entries are dropped. */
  maxQueued: number;
  /** Rows per INSERT. A full batch is written without waiting for the timer. */
  batchSize: number;
  flushIntervalMs: number;
}

export const DEFAULT_AUDIT_QUEUE: AuditQueueOptions = {
  maxQueued: 1_000,
  batchSize: 100,
  flushIntervalMs: 250,
};

export interface AuditLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface AuditRetentionOptions {
  /** Entries older than this many days are deleted. 0 keeps them forever. */
  days: number;
  /** Rows per DELETE statement, so a backlog never becomes one long delete. */
  batchSize: number;
  /** Pause between prune runs. */
  intervalMs: number;
}

export const DEFAULT_AUDIT_RETENTION: AuditRetentionOptions = {
  days: 0,
  batchSize: 1_000,
  intervalMs: 60 * 60 * 1_000,
};

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Reads AUDIT_LOG_RETENTION_DAYS: unset, empty, or 0 keeps entries forever. */
export function parseRetentionDays(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return 0;
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new Error("AUDIT_LOG_RETENTION_DAYS must be a whole number of days; 0 keeps entries forever");
  }
  return days;
}

export interface AuditServiceOptions {
  dialect: DatabaseProviderName;
  /** The admin on/off toggle, read before every write. */
  enabled: () => Promise<boolean>;
  logger?: AuditLogger;
  queue?: Partial<AuditQueueOptions>;
  retention?: Partial<AuditRetentionOptions>;
}

export interface RecordRequestOptions {
  /** Queue the entry instead of awaiting the write. See `recordLater()`. */
  defer?: boolean;
}

export class AuditService {
  private unregister?: () => void;
  private readonly dialect: DatabaseProviderName;
  private readonly enabled: () => Promise<boolean>;
  private readonly logger?: AuditLogger;
  private readonly queueOptions: AuditQueueOptions;
  private queue: AuditRow[] = [];
  private dropped = 0;
  private failing = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private readonly retention: AuditRetentionOptions;
  private pruneTimer?: ReturnType<typeof setTimeout>;
  private pruning?: Promise<void>;
  private closed = false;

  constructor(private readonly sql: SQL, options: AuditServiceOptions) {
    this.dialect = options.dialect;
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.queueOptions = { ...DEFAULT_AUDIT_QUEUE, ...options.queue };
    this.retention = { ...DEFAULT_AUDIT_RETENTION, ...options.retention };
  }

  /** Registers the recorder and, when a retention period is set, starts pruning. */
  connect(): void {
    this.closed = false;
    this.unregister ??= setAuditRecorder({
      record: (entry) => this.record(entry),
      recordLater: (entry) => this.recordLater(entry),
    });
    if (this.retention.days > 0 && !this.pruneTimer && !this.pruning) this.schedulePrune(0);
  }

  /** Stops pruning and the registry, then writes the queue. */
  async close(): Promise<void> {
    this.closed = true;
    this.unregister?.();
    this.unregister = undefined;
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    await this.pruning;
    await this.flush();
  }

  /**
   * Deletes entries older than the retention period, at most `batchSize` rows per
   * statement, until none are left. Returns the number deleted.
   */
  async prune(now: number = Date.now()): Promise<number> {
    if (this.retention.days <= 0) return 0;
    // An ISO string compares correctly with SQLite's text timestamps and casts
    // to timestamptz on PostgreSQL, so one statement serves both.
    const cutoff = new Date(now - this.retention.days * DAY_MS).toISOString();
    let deleted = 0;
    while (!this.closed) {
      // Counted from RETURNING: Bun's SQLite adapter can report zero changes for
      // a DELETE whose subquery starts on its own line.
      const removed = await this.sql<Array<{ id: string }>>`
        DELETE FROM "audit_logs" WHERE "id" IN (
          SELECT "id" FROM "audit_logs"
          WHERE "createdAt" < ${cutoff}
          ORDER BY "createdAt"
          LIMIT ${this.retention.batchSize}
        )
        RETURNING "id"
      `;
      deleted += removed.length;
      if (removed.length < this.retention.batchSize) break;
    }
    if (deleted > 0) {
      await this.record({ action: "audit.pruned", metadata: { count: deleted, before: cutoff } });
    }
    return deleted;
  }

  private schedulePrune(delayMs: number): void {
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      this.pruning = this.prune()
        .then(() => undefined, (error: unknown) => {
          this.logger?.warn({ error: message(error) }, "Audit retention prune failed");
        })
        .finally(() => {
          this.pruning = undefined;
          if (!this.closed) this.schedulePrune(this.retention.intervalMs);
        });
    }, delayMs);
    this.pruneTimer.unref?.();
  }

  /** Writes the entry before resolving. Use for security events. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.persist([this.row(entry)]);
    } catch (error) {
      // Audit persistence must never break the operation it describes.
      this.logger?.warn({ action: entry.action, error: message(error) }, "Audit write failed");
    }
  }

  /**
   * Queues the entry and returns at once. Queued entries are written together
   * every `flushIntervalMs`, as soon as a batch fills, and on `close()`. Entries
   * still queued when the process dies are lost, so keep security events on
   * `record()`.
   */
  recordLater(entry: AuditEntry): void {
    try {
      if (this.queue.length >= this.queueOptions.maxQueued) {
        // Waiting here would turn a slow database into slow requests, which is
        // what deferral avoids. The loss is recorded once the database recovers.
        if (this.dropped === 0) {
          this.logger?.warn(
            { maxQueued: this.queueOptions.maxQueued },
            "Audit queue is full; dropping deferred entries",
          );
        }
        this.dropped += 1;
        return;
      }
      this.queue.push(this.row(entry));
      if (this.queue.length >= this.queueOptions.batchSize) void this.flush();
      else this.scheduleFlush();
    } catch (error) {
      this.logger?.warn({ action: entry.action, error: message(error) }, "Audit entry could not be queued");
    }
  }

  /** Writes every queued entry, one INSERT per batch. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
      if (this.queue.length > 0) this.scheduleFlush();
    });
    return this.flushing;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.queueOptions.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    while (this.queue.length > 0 || this.dropped > 0) {
      const batch = this.queue.splice(0, this.queueOptions.batchSize);
      const dropped = this.dropped;
      this.dropped = 0;
      if (dropped > 0) batch.push(this.row({ action: "audit.dropped", metadata: { count: dropped } }));
      try {
        await this.persist(batch);
        this.failing = false;
      } catch (error) {
        this.dropped += dropped + batch.length - (dropped > 0 ? 1 : 0);
        if (!this.failing) {
          this.logger?.warn({ entries: this.dropped, error: message(error) }, "Audit batch write failed");
        }
        this.failing = true;
        return;
      }
    }
  }

  /** The one write path: checks the admin toggle, then inserts the rows. */
  private async persist(rows: AuditRow[]): Promise<void> {
    if (rows.length === 0 || !(await this.enabled())) return;
    await this.sql`INSERT INTO "audit_logs" ${this.sql(rows, ...COLUMNS)}`;
  }

  private row(entry: AuditEntry): AuditRow {
    const metadata = entry.metadata ?? null;
    return {
      id: crypto.randomUUID(),
      action: entry.action,
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      actorEmail: entry.actorEmail ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      targetLabel: entry.targetLabel ?? null,
      ip: entry.ip ?? null,
      // Bun encodes a bound value as JSON for a jsonb column, so a pre-serialized
      // string would be stored as a JSON string. SQLite keeps the text column.
      metadata: metadata === null || this.dialect === "postgres" ? metadata : JSON.stringify(metadata),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * One page of entries in ("createdAt", "id") order. Keyset paging keeps every
   * page as cheap as the first, however deep the caller reads.
   */
  async list(query: AuditLogQuery = {}): Promise<AuditLogPage> {
    const sql = this.sql;
    const requested = Number.isFinite(query.limit) ? Math.trunc(query.limit ?? 0) : DEFAULT_AUDIT_PAGE_SIZE;
    const limit = Math.min(Math.max(requested, 1), MAX_AUDIT_PAGE_SIZE);
    const after = query.cursor ? this.decodeCursor(query.cursor) : null;
    const descending = query.order !== "asc";
    const rows = await sql<AuditLogRow[]>`
      SELECT "id", "action", "actorId", "actorName", "actorEmail",
             "targetType", "targetId", "targetLabel", "ip", "metadata", "createdAt"
      FROM "audit_logs"
      WHERE 1 = 1
        ${query.action ? sql`AND "action" = ${query.action}` : sql``}
        ${query.actor ? sql`AND "actorEmail" = ${query.actor}` : sql``}
        ${query.target ? sql`AND "targetLabel" = ${query.target}` : sql``}
        ${after
          ? descending
            ? sql`AND ("createdAt", "id") < (${after.createdAt}, ${after.id})`
            : sql`AND ("createdAt", "id") > (${after.createdAt}, ${after.id})`
          : sql``}
      ${descending
        ? sql`ORDER BY "createdAt" DESC, "id" DESC`
        : sql`ORDER BY "createdAt" ASC, "id" ASC`}
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(view),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /** Distinct action codes, for filter menus. */
  async actions(): Promise<string[]> {
    // A loose index scan: each step seeks the next larger code in the action
    // index, so the cost follows the number of codes rather than rows.
    const rows = await this.sql<Array<{ action: string | null }>>`
      WITH RECURSIVE "codes"("action") AS (
        SELECT MIN("action") FROM "audit_logs"
        UNION ALL
        SELECT (SELECT MIN("action") FROM "audit_logs" WHERE "action" > "codes"."action")
        FROM "codes"
        WHERE "codes"."action" IS NOT NULL
      )
      SELECT "action" FROM "codes" WHERE "action" IS NOT NULL LIMIT ${MAX_LISTED_ACTIONS}
    `;
    return rows.flatMap((row) => row.action === null ? [] : [row.action]);
  }

  private decodeCursor(cursor: string): AuditPosition {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (Array.isArray(value) && value.length === 2) {
        const [createdAt, id] = value as unknown[];
        if (
          typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) &&
          typeof id === "string" && id.length > 0 && (this.dialect !== "postgres" || UUID.test(id))
        ) {
          return { createdAt, id };
        }
      }
    } catch {
      // Malformed base64 or JSON is reported below like any other bad cursor.
    }
    throw new AppException("INVALID_CURSOR", "The audit log cursor is invalid", 400);
  }

  async recordRequest(
    action: string,
    request: Request,
    session: AuthSession,
    target: AuditTarget = {},
    options: RecordRequestOptions = {},
  ): Promise<void> {
    const entry: AuditEntry = {
      action,
      actorId: session.user.id,
      actorName: typeof session.user.name === "string" ? session.user.name : null,
      actorEmail: typeof session.user.email === "string" ? session.user.email : null,
      targetType: target.type ?? null,
      targetId: target.id ?? null,
      targetLabel: target.label ?? null,
      metadata: target.metadata ?? null,
      ip: clientAddressOf(request.headers) ?? null,
    };
    if (options.defer) this.recordLater(entry);
    else await this.record(entry);
  }
}

function view(row: AuditLogRow): AuditLogView {
  return {
    ...row,
    metadata: typeof row.metadata === "string"
      ? JSON.parse(row.metadata) as Record<string, unknown>
      : row.metadata as Record<string, unknown> | null,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString(),
  };
}

// Keeps the stored timestamp text as is: SQLite compares it as a string, so a
// reformatted value could skip or repeat rows.
function encodeCursor(row: AuditLogRow): string {
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
  return Buffer.from(JSON.stringify([createdAt, row.id])).toString("base64url");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
