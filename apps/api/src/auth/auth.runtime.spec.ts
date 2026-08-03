import { afterEach, describe, expect, it } from "@jest/globals";
import { authBaseUrl, authSecret } from "./auth-environment";

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("authentication production environment", () => {
  it("rejects missing and placeholder production secrets", () => {
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => authSecret()).toThrow("must be set");
    process.env.BETTER_AUTH_SECRET = "change-me-in-production-min-32-characters";
    expect(() => authSecret()).toThrow("non-placeholder");
  });

  it("requires an HTTPS production origin", () => {
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_URL;
    expect(() => authBaseUrl()).toThrow("must be set");
    process.env.BETTER_AUTH_URL = "http://app.example.com";
    expect(() => authBaseUrl()).toThrow("must use HTTPS");
    process.env.BETTER_AUTH_URL = "https://app.example.com";
    expect(authBaseUrl()).toBe("https://app.example.com");
  });
});
