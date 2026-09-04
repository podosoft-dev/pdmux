import { describe, expect, it } from "bun:test";
import {
  certificateMatches,
  isAllowedAppNavigation,
  isAllowedExternalUrl,
} from "./security.js";

describe("[TC-PDDESKTOP-006] desktop navigation and certificate policy", () => {
  const appUrl = "http://127.0.0.1:51001";

  it("keeps application navigation on its configured origin", () => {
    expect(isAllowedAppNavigation(`${appUrl}/hosts`, appUrl)).toBe(true);
    expect(isAllowedAppNavigation("https://example.com", appUrl)).toBe(false);
  });

  it("opens only external HTTPS URLs outside the application origin", () => {
    expect(isAllowedExternalUrl("https://example.com/docs", appUrl)).toBe(true);
    expect(isAllowedExternalUrl("http://example.com", appUrl)).toBe(false);
    expect(isAllowedExternalUrl(`${appUrl}/account`, appUrl)).toBe(false);
  });

  it("requires both the remote host and SHA-256 pin to match", () => {
    const pin = "AB".repeat(32);
    expect(certificateMatches("example.com", pin, "https://example.com", [pin])).toBe(true);
    expect(certificateMatches("other.example.com", pin, "https://example.com", [pin])).toBe(false);
    expect(certificateMatches("example.com", "CD".repeat(32), "https://example.com", [pin])).toBe(false);
  });
});
