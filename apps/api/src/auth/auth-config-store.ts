import { createConfigStore } from "@podosoft/podokit-auth";
import { pool } from "./db";

// One process-wide store keeps the auth runtime and capabilities endpoint on the
// same cache snapshot. Admin writes invalidate this store before rebuilding auth.
export const authConfigStore = createConfigStore(pool);
