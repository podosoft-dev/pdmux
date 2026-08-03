import { Module } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LoggerModule } from "nestjs-pino";

const isProduction = process.env.NODE_ENV === "production";

// Structured request logging with a correlation id. Importing this module
// installs the pino-http middleware for all routes.
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        // Pretty, single-line logs in dev; JSON in production.
        transport: isProduction ? undefined : { target: "pino-pretty", options: { singleLine: true } },
        autoLogging: true,
        // One id per request; honor an inbound x-request-id and echo it back.
        genReqId: (req: IncomingMessage, res: ServerResponse): string => {
          const header = req.headers["x-request-id"];
          const id = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
          res.setHeader("x-request-id", id);
          return id;
        },
      },
    }),
  ],
})
export class LoggingModule {}
