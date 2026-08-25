import pino from "pino";
import { LOGGER, type PodokitModule } from "../core/services";

export const loggingModule: PodokitModule = {
  name: "logging",
  configure: (_env, services): void => {
    const isProduction = process.env.NODE_ENV === "production";
    const logger = pino({
      level: process.env.LOG_LEVEL ?? "info",
      transport: isProduction
        ? undefined
        : { target: "pino-pretty", options: { singleLine: true } },
    });
    services.override(LOGGER, logger);
  },
};
