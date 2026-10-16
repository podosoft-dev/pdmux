import { Elysia } from "elysia";
import { AppException } from "../common/app-exception";
import type { AppPlugin } from "../core/services";
import { DATABASE_READINESS_CHECK } from "./readiness.service";

export const healthPlugin: AppPlugin = ({ readiness }) =>
  new Elysia({ name: "podokit.health" })
    .get(
      "/health",
      () => ({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() }),
      { detail: { tags: ["health"], summary: "Check API liveness" } },
    )
    .get(
      "/health/ready",
      async () => {
        const { [DATABASE_READINESS_CHECK]: db, ...checks } = await readiness.run();
        const down = [
          ...(db === "up" ? [] : ["db"]),
          ...Object.entries(checks).flatMap(([name, status]) => status === "down" ? [name] : []),
        ];
        if (down.length > 0) {
          throw new AppException(
            "READINESS_FAILED",
            `One or more dependencies are unavailable: ${down.join(", ")}`,
            503,
          );
        }
        return { status: "ready" as const, db: "up" as const, checks };
      },
      { detail: { tags: ["health"], summary: "Check API dependencies" } },
    );
