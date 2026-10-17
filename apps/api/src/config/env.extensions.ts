import { z } from "zod";
import type { AppEnv } from "./env.validation";

// This owned file is never overwritten by `podo update`. Declare the
// application's environment variables here: they are validated with PodoKit's
// at startup, fail it with the same message when invalid, and are typed on
// `AppEnv`. A name PodoKit already defines is rejected.
export const appEnvShape = {
  // pdmux's TypeORM pool, which the API and the worker each open beside
  // PodoKit's DB_POOL_MAX and DB_AUTH_POOL_MAX pools. A deployment profile
  // counts it with `dependencies.postgres.appPools` `{ "sizeKey": "PDMUX_DB_POOL_MAX" }`.
  PDMUX_DB_POOL_MAX: z.coerce.number().int().positive().default(10),
} satisfies z.ZodRawShape;

/**
 * Checks across variables, such as one that production requires. Report a
 * problem with `context.addIssue({ code: "custom", path: ["NAME"], message })`.
 */
export function refineAppEnv(_env: AppEnv, _context: z.RefinementCtx): void {}
