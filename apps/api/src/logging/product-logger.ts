import pino, { type Logger } from "pino";

const rootLogger = pino({ level: process.env.LOG_LEVEL ?? "info" });

/** Lightweight structured logger for pdmux domain services. */
export class ProductLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = rootLogger.child({ context });
  }

  log(message: string): void {
    this.logger.info(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  error(message: string): void {
    this.logger.error(message);
  }

  debug(message: string): void {
    this.logger.debug(message);
  }
}
