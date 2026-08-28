import pino, { type LoggerOptions } from "pino";
import type { AppEnv } from "../config/env.validation";
import { LOGGER, type PodokitModule } from "../core/services";

export function loggingOptions(env: Pick<AppEnv, "NODE_ENV">): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    transport: env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { singleLine: true } },
  };
}

export const loggingModule: PodokitModule = {
  name: "logging",
  configure: (env, services): void => {
    const logger = pino(loggingOptions(env));
    services.override(LOGGER, logger);
  },
};
