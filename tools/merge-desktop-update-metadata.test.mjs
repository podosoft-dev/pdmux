import { describe, expect, test } from "bun:test";
import { mergeUpdateMetadata } from "./merge-desktop-update-metadata.mjs";

function metadata(version, url, sha512) {
  return {
    source: url,
    contents: Bun.YAML.stringify({
      version,
      files: [{ url, sha512, size: 42 }],
      path: url,
      sha512,
      releaseDate: "2026-09-04T00:00:00.000Z",
    }),
  };
}

describe("[TC-PDDESKTOP-009] desktop update metadata", () => {
  test("merges native macOS artifacts into one architecture-aware channel", () => {
    const merged = Bun.YAML.parse(mergeUpdateMetadata([
      metadata("0.12.0", "pdmux-0.12.0-mac-x64.zip", "intel"),
      metadata("0.12.0", "pdmux-0.12.0-mac-arm64.zip", "apple-silicon"),
    ]));
    expect(merged.version).toBe("0.12.0");
    expect(merged.files.map((file) => file.url)).toEqual([
      "pdmux-0.12.0-mac-x64.zip",
      "pdmux-0.12.0-mac-arm64.zip",
    ]);
    expect(merged.path).toBe("pdmux-0.12.0-mac-x64.zip");
    expect(merged.sha512).toBe("intel");
  });

  test("rejects metadata from different releases", () => {
    expect(() => mergeUpdateMetadata([
      metadata("0.12.0", "pdmux-0.12.0-mac-x64.zip", "intel"),
      metadata("0.13.0", "pdmux-0.13.0-mac-arm64.zip", "apple-silicon"),
    ])).toThrow("versions do not match");
  });
});
