import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMessages } from "./messages";

describe("loadMessages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reuses one merged catalog per locale pair in a build", async () => {
    vi.stubEnv("DEV", false);

    const korean = await loadMessages("ko", "en");

    expect(korean.nav.users).toBe("회원");
    expect(await loadMessages("ko", "en")).toBe(korean);
    expect(await loadMessages("KO", null)).toBe(korean);
    expect(await loadMessages("en", "en")).not.toBe(korean);
  });

  it("merges again in development so edited catalogs appear", async () => {
    vi.stubEnv("DEV", true);

    const first = await loadMessages("en");
    const second = await loadMessages("en");

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
