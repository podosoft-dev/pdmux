import { Elysia } from "elysia";
import { AppException } from "../common/app-exception";
import type { AppPlugin } from "../core/services";

export const healthPlugin: AppPlugin = ({ database, readiness }) =>
  new Elysia({ name: "podokit.health" })
    .get(
      "/health",
      () => ({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() }),
      { detail: { tags: ["health"], summary: "Check API liveness" } },
    )
    .get(
      "/health/ready",
      async () => {
        let db: "up" | "down" = "up";
        try {
          await database.ping();
        } catch {
          db = "down";
        }
        const checks = await readiness.run();
        if (db === "down" || Object.values(checks).includes("down")) {
          throw new AppException("READINESS_FAILED", "One or more dependencies are unavailable", 503);
        }
        return { status: "ready" as const, db: "up" as const, checks };
      },
      { detail: { tags: ["health"], summary: "Check API dependencies" } },
    );
