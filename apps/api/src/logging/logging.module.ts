import pino, { type LoggerOptions } from "pino";
import type { AppEnv } from "../config/env.validation";
import { LOGGER, type PodokitModule } from "../core/services";

/** Pretty single-line logs in development, JSON in production. */
export function loggingOptions(env: Pick<AppEnv, "NODE_ENV">): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    // pino-pretty is a development dependency, so production must not ask for it.
    transport: env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { singleLine: true } },
  };
}

export const loggingModule: PodokitModule = {
  name: "logging",
  configure: (env, services): void => {
    services.override(LOGGER, pino(loggingOptions(env)));
  },
};
