import { describe, expect, it } from "bun:test";
import { validateEnv } from "../config/env.validation";
import { loggingOptions } from "./logging.module";

// The production image installs no development dependencies, so an API that asked
// for pino-pretty there exited at startup (REQ-PDHOST-021).
describe("[TC-PDHOST-027] production logging", () => {
  it("starts the logger without the development transport in production", () => {
    expect(loggingOptions(validateEnv({ NODE_ENV: "production" })).transport).toBeUndefined();
    expect(loggingOptions(validateEnv({ NODE_ENV: "development" })).transport)
      .toMatchObject({ target: "pino-pretty" });
  });
});
