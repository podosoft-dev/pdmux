import { describe, expect, it } from "vitest";
import { monospaceFamilies } from "../src/lib/desktop/terminal-fonts.js";

describe("[TC-PDDESKTOP-025] installed terminal font selection", () => {
  it("uses only enumerated OS families and filters proportional faces", () => {
    const result = monospaceFamilies(["My Downloaded Font", "D2Coding", "Arial", "D2Coding", "", "Bad\nFont"], (family, text) => family === "Arial" && text.startsWith("i") ? 40 : 128);
    expect(result).toEqual(["D2Coding", "My Downloaded Font"]);
    expect(monospaceFamilies(["Unavailable"], () => NaN)).toEqual([]);
    expect(monospaceFamilies(["Zero"], () => 0)).toEqual([]);
  });
  it("does not restrict fonts to one operating system or a preset list", () => {
    for (const family of ["My macOS Mono", "My Windows Mono", "My Linux Mono"]) {
      expect(monospaceFamilies([family], () => 100)).toEqual([family]);
    }
  });
});
