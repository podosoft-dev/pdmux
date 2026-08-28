import { describe, expect, it } from "bun:test";
import { loggingOptions } from "./logging.module";

describe("logging options", () => {
  it("[TC-PDHOST-027] disables the development transport in production", () => {
    expect(loggingOptions({ NODE_ENV: "production" }).transport).toBeUndefined();
  });

  it("keeps readable single-line logs in development", () => {
    expect(loggingOptions({ NODE_ENV: "development" }).transport).toEqual({
      target: "pino-pretty",
      options: { singleLine: true },
    });
  });
});
