import type { SQL } from "bun";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";

/** Give every active session the configured lifetime from now. */
export async function resetSessionExpirations(
  sql: SQL,
  provider: DatabaseProviderName,
  lifetimeSeconds: number,
  now: Date = new Date(),
): Promise<void> {
  if (provider === "sqlite") {
    // Better Auth stores SQLite dates as ISO 8601 text, which sorts in time
    // order. SQLite has no interval arithmetic.
    const current = now.toISOString();
    const expiresAt = new Date(now.getTime() + lifetimeSeconds * 1000).toISOString();
    await sql`
      UPDATE "session"
      SET "expiresAt" = ${expiresAt}, "updatedAt" = ${current}
      WHERE "expiresAt" > ${current}
    `;
    return;
  }
  await sql`
    UPDATE "session"
    SET "expiresAt" = CURRENT_TIMESTAMP + (${lifetimeSeconds} * INTERVAL '1 second'),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "expiresAt" > CURRENT_TIMESTAMP
  `;
}
