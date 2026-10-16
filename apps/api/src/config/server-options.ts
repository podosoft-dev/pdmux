import * as extensions from "../app.extensions";
import type { AppEnv } from "./env.validation";

/** Bun's default request body limit. */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 128 * 1024 * 1024;
const MAX_IDLE_TIMEOUT_SECONDS = 255;

/** Bun server options an application sets from `app.extensions.ts`. */
export interface ApiServerOptions {
  /** The largest request body in bytes. Defaults to `API_MAX_REQUEST_BODY_SIZE`. */
  maxRequestBodySize?: number;
  /**
   * Seconds a connection may stay idle before it is closed, from 0 (never) to
   * 255. Defaults to Elysia's 30 seconds.
   */
  idleTimeout?: number;
}

/** A fixed set of options, or a function of the validated environment. */
export type ApiServerOptionsSource = ApiServerOptions | ((env: AppEnv) => ApiServerOptions);

// `apiServerOptions` is an optional export of the application-owned
// app.extensions.ts. The index signature keeps extension files written before
// it existed assignable, while a wrongly typed export still fails to compile.
const owned: { readonly [name: string]: unknown; readonly apiServerOptions?: ApiServerOptionsSource } = extensions;

/**
 * The Bun serve options for the API. Values from `apiServerOptions` win over
 * the environment; the function form receives the environment to combine both.
 */
export function apiServerOptions(
  env: AppEnv,
  source: ApiServerOptionsSource | undefined = owned.apiServerOptions,
): ApiServerOptions & { maxRequestBodySize: number } {
  const options = typeof source === "function" ? source(env) : source ?? {};
  const maxRequestBodySize = options.maxRequestBodySize ?? env.API_MAX_REQUEST_BODY_SIZE;
  if (!Number.isSafeInteger(maxRequestBodySize) || maxRequestBodySize < 1) {
    throw new Error("apiServerOptions.maxRequestBodySize must be a positive integer of bytes");
  }
  const { idleTimeout } = options;
  if (
    idleTimeout !== undefined &&
    (!Number.isInteger(idleTimeout) || idleTimeout < 0 || idleTimeout > MAX_IDLE_TIMEOUT_SECONDS)
  ) {
    throw new Error(`apiServerOptions.idleTimeout must be an integer from 0 to ${MAX_IDLE_TIMEOUT_SECONDS} seconds`);
  }
  return { maxRequestBodySize, ...(idleTimeout === undefined ? {} : { idleTimeout }) };
}
