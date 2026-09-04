import { describe, expect, it } from "bun:test";
import { DEFAULT_DESKTOP_CONFIG, parseDesktopConfig } from "./config.js";
import { desktopMessages } from "./i18n.js";

describe("[TC-PDDESKTOP-004] desktop configuration", () => {
  it("uses an embedded local runtime by default", () => {
    expect(parseDesktopConfig(undefined)).toEqual(DEFAULT_DESKTOP_CONFIG);
  });

  it("normalizes a pinned HTTPS remote", () => {
    const config = parseDesktopConfig({
      mode: "remote",
      url: "https://example.com/pdmux",
      certificatePins: ["AA:".repeat(31) + "AA"],
    });
    expect(config).toEqual({
      mode: "remote",
      url: "https://example.com/pdmux",
      certificatePins: ["AA".repeat(32)],
      closeToTray: true,
    });
  });

  it("rejects plaintext remotes, missing pins, and unknown keys", () => {
    expect(() => parseDesktopConfig({ mode: "remote", url: "http://example.com", certificatePins: ["AA".repeat(32)] })).toThrow();
    expect(() => parseDesktopConfig({ mode: "remote", url: "https://example.com", certificatePins: [] })).toThrow();
    expect(() => parseDesktopConfig({ ...DEFAULT_DESKTOP_CONFIG, unexpected: true })).toThrow();
  });

  it("localizes desktop-only operating-system surfaces", () => {
    expect(desktopMessages("ko-KR").backup).toBe("백업 만들기");
    expect(desktopMessages("en-US").backup).toBe("Create backup");
  });
});
