import type { z } from "zod";
import type { AppEnv } from "./env.validation";

// This owned file is never overwritten by `podo update`. Declare the
// application's environment variables here: they are validated with PodoKit's
// at startup, fail it with the same message when invalid, and are typed on
// `AppEnv`. A name PodoKit already defines is rejected. For example:
//
//   import { z } from "zod";
//   export const appEnvShape = {
//     REPORTS_BUCKET: z.string().min(1),
//     SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
//   } satisfies z.ZodRawShape;
export const appEnvShape = {} satisfies z.ZodRawShape;

/**
 * Checks across variables, such as one that production requires. Report a
 * problem with `context.addIssue({ code: "custom", path: ["NAME"], message })`.
 */
export function refineAppEnv(_env: AppEnv, _context: z.RefinementCtx): void {}
