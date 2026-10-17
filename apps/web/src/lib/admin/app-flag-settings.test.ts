import { describe, expect, it, vi } from "vitest";
import type { Messages } from "#lib/i18n/messages.js";
import { appFlagCards } from "./app-flag-settings";

// Stands in for the application's own list in the app-owned app-flags.ts.
vi.mock("./app-flags", () => ({
  APP_FLAG_SETTINGS: [
    { flag: "reportsEnabled", label: () => "Reports", description: () => "Show the reports page." },
    { flag: "betaSearch", label: () => "Beta search" },
  ],
}));

const t = {} as Messages;

describe("application flag settings", () => {
  it("shows each listed flag with the value the API reports", () => {
    expect(appFlagCards(t, { appFlags: { reportsEnabled: true, betaSearch: false, hidden: true } })).toEqual([
      { flag: "reportsEnabled", name: "Reports", description: "Show the reports page.", available: true, on: true },
      { flag: "betaSearch", name: "Beta search", description: "", available: true, on: false },
    ]);
  });

  it("marks a flag the API does not report as unavailable", () => {
    expect(appFlagCards(t, { appFlags: { reportsEnabled: false } })[1]).toMatchObject({
      flag: "betaSearch",
      available: false,
      on: false,
    });
    expect(appFlagCards(t, undefined).every((card) => !card.available)).toBe(true);
  });
});
