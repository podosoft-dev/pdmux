import { describe, expect, it } from "bun:test";
import { ApiKeyVerifier } from "./api-key-verifier";
import { requireApiKey } from "./api-key.module";

describe("requireApiKey", () => {
  it("accepts a configured key and rejects missing or invalid keys", () => {
    const previous = process.env.API_KEYS;
    process.env.API_KEYS = "service-key";
    try {
      const verifier = new ApiKeyVerifier();
      expect(() => requireApiKey(new Headers({ "x-api-key": "service-key" }), verifier)).not.toThrow();
      expect(() => requireApiKey(new Headers(), verifier)).toThrow("Missing X-API-Key");
      expect(() => requireApiKey(new Headers({ "x-api-key": "invalid" }), verifier)).toThrow(
        "Invalid API key",
      );
    } finally {
      if (previous === undefined) delete process.env.API_KEYS;
      else process.env.API_KEYS = previous;
    }
  });
});
