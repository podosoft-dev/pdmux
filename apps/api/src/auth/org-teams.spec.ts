import { describe, expect, test } from "bun:test";
import { assertTeamsEnabled, TEAMS_DISABLED } from "./org-teams";

describe("organization teams", () => {
  test("answers 404 unless both organizations and teams are on", () => {
    for (const flags of [
      { organization: false, teams: false },
      { organization: true, teams: false },
      { organization: false, teams: true },
    ]) {
      expect(() => assertTeamsEnabled(flags)).toThrow(expect.objectContaining({ code: TEAMS_DISABLED, statusCode: 404 }));
    }
    expect(() => assertTeamsEnabled({ organization: true, teams: true })).not.toThrow();
  });
});
