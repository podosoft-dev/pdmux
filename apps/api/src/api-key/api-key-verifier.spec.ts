import { afterEach, describe, expect, it } from "bun:test";
import { ApiKeyVerifier } from "./api-key-verifier";

const originalApiKeys = process.env.API_KEYS;

afterEach(() => {
  if (originalApiKeys === undefined) {
    delete process.env.API_KEYS;
  } else {
    process.env.API_KEYS = originalApiKeys;
  }
});

describe("ApiKeyVerifier", () => {
  it("accepts trimmed configured keys and rejects other values", () => {
    process.env.API_KEYS = " first-service-key, second-service-key , ";
    const verifier = new ApiKeyVerifier();

    expect(verifier.isValid("first-service-key")).toBe(true);
    expect(verifier.isValid("second-service-key")).toBe(true);
    expect(verifier.isValid("different-service-key")).toBe(false);
  });

  it("rejects keys when the allowlist is empty", () => {
    delete process.env.API_KEYS;

    expect(new ApiKeyVerifier().isValid("any-service-key")).toBe(false);
  });

  it("compares fixed-length digests for differently sized input", () => {
    process.env.API_KEYS = "short";
    const verifier = new ApiKeyVerifier();

    expect(verifier.isValid("a-much-longer-unconfigured-service-key")).toBe(false);
  });
});
