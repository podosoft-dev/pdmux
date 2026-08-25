import { describe, expect, test } from "bun:test";
import { validateSiteSetting } from "./site-settings.validation";

describe("validateSiteSetting", () => {
  test("normalizes safe theme and locale values", () => {
    expect(validateSiteSetting("locale", "ko-kr")).toBe("ko-KR");
    expect(validateSiteSetting("themeRadius", "2.0")).toBe("2");
    expect(validateSiteSetting(
      "themeOverrides",
      JSON.stringify({ light: { primary: "#112233" } }),
    )).toBe('{"light":{"primary":"#112233"}}');
  });

  test("rejects unknown keys and CSS injection values", () => {
    expect(() => validateSiteSetting("unknown", "value")).toThrow("Unknown setting");
    expect(() => validateSiteSetting("brandColor", "red;display:none")).toThrow("hex color");
    expect(() => validateSiteSetting(
      "themeOverrides",
      JSON.stringify({ light: { unknown: "#fff" } }),
    )).toThrow("Unknown theme token");
  });
});
