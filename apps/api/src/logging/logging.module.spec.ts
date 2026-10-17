import { describe, expect, test } from "bun:test";
import { validateEnv } from "../config/env.validation";
import { loggingOptions } from "./logging.module";

describe("logging options", () => {
  test("writes JSON without the development transport in production", () => {
    expect(loggingOptions(validateEnv({ NODE_ENV: "production" })).transport).toBeUndefined();
  });

  test("pretty-prints single lines in development", () => {
    expect(loggingOptions(validateEnv({})).transport).toEqual({
      target: "pino-pretty",
      options: { singleLine: true },
    });
  });
});
