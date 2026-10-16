import { AppException } from "@podosoft/podokit-contracts";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import type { SQL } from "bun";

export const ADMIN_SESSION_CURSOR_INVALID = "ADMIN_SESSION_CURSOR_INVALID";
export const ADMIN_SESSIONS_DEFAULT_LIMIT = 20;
export const ADMIN_SESSIONS_MAX_LIMIT = 100;

/** An active session as administrators see it. The bearer token never leaves the server. */
export interface AdminSessionView {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AdminSessionPage {
  items: AdminSessionView[];
  nextCursor: string | null;
  total: number;
}

export interface AdminSessionQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  userId?: string;
  /** A session to leave out, such as the caller's own. */
  excludeId?: string;
}

interface SessionRow {
  id: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
  createdAt: Date | string;
  expiresAt: Date | string;
  cursorAt: string;
}

interface Cursor {
  createdAt: string;
  id: string;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      !Number.isNaN(Date.parse(parsed[0]))
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Reported below as one stable error code.
  }
  throw new AppException(ADMIN_SESSION_CURSOR_INVALID, "The sessions cursor is invalid.", 400);
}

function view(row: SessionRow): AdminSessionView {
  return {
    id: row.id,
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName ?? "",
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    impersonatedBy: row.impersonatedBy,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  };
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Lists active sessions across users with keyset paging on ("createdAt", "id"),
 * so a page costs one bounded query however many users or sessions exist.
 */
export class AdminSessionsService {
  constructor(
    private readonly sql: SQL,
    private readonly provider: DatabaseProviderName,
  ) {}

  async list(query: AdminSessionQuery = {}): Promise<AdminSessionPage> {
    const limit = Math.min(Math.max(query.limit ?? ADMIN_SESSIONS_DEFAULT_LIMIT, 1), ADMIN_SESSIONS_MAX_LIMIT);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const search = query.search?.trim() ?? "";
    // ISO-8601 text matches the SQLite storage format and still compares as a
    // timestamp against PostgreSQL timestamptz columns.
    const now = new Date().toISOString();
    const filters = (): SQL.Query<unknown> => this.sql`
      WHERE s."expiresAt" > ${now}
      ${query.userId ? this.sql`AND s."userId" = ${query.userId}` : this.sql``}
      ${query.excludeId ? this.sql`AND s."id" <> ${query.excludeId}` : this.sql``}
      ${search ? this.searchFilter(likePattern(search)) : this.sql``}
    `;
    const [rows, totals] = await Promise.all([
      this.sql<SessionRow[]>`
        SELECT s."id", s."userId", u."email" AS "userEmail", u."name" AS "userName",
               s."ipAddress", s."userAgent", s."impersonatedBy", s."createdAt", s."expiresAt",
               CAST(s."createdAt" AS TEXT) AS "cursorAt"
        FROM "session" s
        JOIN "user" u ON u."id" = s."userId"
        ${filters()}
        ${cursor
          ? this.sql`AND (s."createdAt" < ${cursor.createdAt}
              OR (s."createdAt" = ${cursor.createdAt} AND s."id" < ${cursor.id}))`
          : this.sql``}
        ORDER BY s."createdAt" DESC, s."id" DESC
        LIMIT ${limit + 1}
      `,
      this.sql<Array<{ total: number | string | bigint }>>`
        SELECT COUNT(*) AS "total"
        FROM "session" s
        JOIN "user" u ON u."id" = s."userId"
        ${filters()}
      `,
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(view),
      // The cursor keeps the database's own text form so sub-millisecond
      // timestamps cannot skip or repeat rows at a page boundary.
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.cursorAt, id: last.id }) : null,
      total: Number(totals[0]?.total ?? 0),
    };
  }

  /** One active session, or null when it does not exist or has expired. */
  async find(sessionId: string): Promise<AdminSessionView | null> {
    const now = new Date().toISOString();
    const rows = await this.sql<SessionRow[]>`
      SELECT s."id", s."userId", u."email" AS "userEmail", u."name" AS "userName",
             s."ipAddress", s."userAgent", s."impersonatedBy", s."createdAt", s."expiresAt",
             CAST(s."createdAt" AS TEXT) AS "cursorAt"
      FROM "session" s
      JOIN "user" u ON u."id" = s."userId"
      WHERE s."id" = ${sessionId} AND s."expiresAt" > ${now}
    `;
    return rows[0] ? view(rows[0]) : null;
  }

  /** The token of a session, only when `userId` is given and owns it. */
  async tokenOf(sessionId: string, userId?: string): Promise<string | null> {
    const rows = await this.sql<Array<{ token: string }>>`
      SELECT "token" FROM "session"
      WHERE "id" = ${sessionId} ${userId === undefined ? this.sql`` : this.sql`AND "userId" = ${userId}`}
    `;
    return rows[0]?.token ?? null;
  }

  private searchFilter(pattern: string): SQL.Query<unknown> {
    return this.provider === "sqlite"
      ? this.sql`AND (u."email" LIKE ${pattern} ESCAPE '\\' OR u."name" LIKE ${pattern} ESCAPE '\\')`
      : this.sql`AND (u."email" ILIKE ${pattern} ESCAPE '\\' OR u."name" ILIKE ${pattern} ESCAPE '\\')`;
  }
}
