import { expect, it } from "bun:test";
import { authorizationCode } from "./auth-code.js";
it("[TC-PDDESKTOP-011] preserves callback state and accepts percent-encoded base64 padding", () => {
  const value = Buffer.from(JSON.stringify({ identifier: "a".repeat(32), state: "b".repeat(16) })).toString("base64url");
  expect(authorizationCode(encodeURIComponent(`${value}=`))).toBe(`${value}=`);
  expect(() => authorizationCode("a".repeat(32))).toThrow();
  expect(() => authorizationCode("https://outside")).toThrow();
});
