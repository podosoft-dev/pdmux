import { describe, expect, it } from "bun:test";
import { migrationWorkingDirectory } from "../scripts/run-migrations.mjs";

describe("migration runner", () => {
  it("[TC-PDHOST-025] runs from the API package so Bun loads its decorator settings", () => {
    expect(migrationWorkingDirectory("file:///workspace/apps/api/scripts/run-migrations.mjs")).toBe(
      "/workspace/apps/api/",
    );
  });
});
