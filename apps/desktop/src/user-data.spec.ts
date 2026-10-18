import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { userDataDirectory } from "./user-data.js";

describe("[TC-PDDESKTOP-009] isolated package user data", () => {
  it("preserves the default and accepts an explicit absolute verification profile", () => {
    expect(userDataDirectory(["pdmux"])).toBeUndefined();
    const path = resolve("profile with spaces");
    expect(userDataDirectory(["pdmux", `--user-data-dir=${path}`])).toBe(path);
    expect(userDataDirectory(["pdmux", "--user-data-dir", path])).toBe(path);
  });
  it("refuses ambiguous or missing profiles before using a real user's data", () => {
    for (const args of [["--user-data-dir"], ["--user-data-dir="], ["--user-data-dir=relative"], ["--user-data-dir=/one", "--user-data-dir=/two"]]) {
      expect(() => userDataDirectory(args)).toThrow("exactly one absolute");
    }
  });
});
