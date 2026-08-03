/**
 * What the fleet settings screen refuses, what it sends, and what it deletes.
 *
 * All of it is pure on purpose: a UI assertion can see that a message appeared, but not
 * that the patch left out the fields nobody touched, nor that a mirrored bound still
 * matches the server that enforces it. Those are the rules worth locking, so they live
 * in functions rather than in a component.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FLEET_FIELD_GROUPS,
  FLEET_LIST_KEYS,
  FLEET_NUMBER_BOUNDS,
  FLEET_NUMBER_KEYS,
  FLEET_SETTING_FALLBACK,
  armsHostSweep,
  draftFrom,
  hostsPastWindow,
  listText,
  parseListField,
  parseNumberField,
  reviewDraft,
  savedNumber,
} from "$lib/dashboard/fleet-settings";
import type { FleetSettingsView } from "$lib/dashboard/types";

/**
 * The API module this app mirrors.
 *
 * READ, NOT IMPORTED. `apps/api` is a NestJS workspace whose modules pull in decorators
 * and TypeORM, so importing one into a browser-side test would drag the server into the
 * app's dependency graph — the same reason `types.ts` restates the wire shapes by hand.
 * Reading the file as text costs nothing and is enough to compare two tables of numbers.
 */
const API_SETTINGS = new URL("../../api/src/fleet/fleet-settings.ts", import.meta.url).pathname;

/** The body of a top-level `const NAME… = { … };` declaration, comments stripped. */
function declarationBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`);
  expect(start, `${name} is no longer declared in fleet-settings.ts`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n};", open);
  expect(end, `${name} is no longer a single object literal`).toBeGreaterThan(open);
  return source
    .slice(open, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
}

/** `86_400` is a number to TypeScript and a string with an underscore to a regex. */
const asNumber = (raw: string): number => Number(raw.replace(/_/g, ""));

function apiBounds(source: string): Record<string, { min: number; max: number }> {
  const body = declarationBody(source, "NUMBER_BOUNDS");
  const out: Record<string, { min: number; max: number }> = {};
  for (const match of body.matchAll(/(\w+):\s*\{\s*min:\s*([\d_]+),\s*max:\s*([\d_]+)\s*\}/g)) {
    out[match[1]!] = { min: asNumber(match[2]!), max: asNumber(match[3]!) };
  }
  return out;
}

function apiDefaults(source: string): Record<string, number | string[]> {
  const body = declarationBody(source, "FLEET_SETTING_DEFAULTS");
  const out: Record<string, number | string[]> = {};
  for (const match of body.matchAll(/^\s{2}(\w+):\s*(.+?),\s*$/gm)) {
    const raw = match[2]!.trim();
    out[match[1]!] = raw.startsWith("[")
      ? (JSON.parse(raw) as string[])
      : asNumber(raw);
  }
  return out;
}

function settings(overrides: Partial<FleetSettingsView> = {}): FleetSettingsView {
  return { ...FLEET_SETTING_FALLBACK, ...overrides };
}

describe("[TC-PDWEB-019] the screen refuses a value the API would refuse, before sending it", () => {
  it("rejects an empty field as missing rather than reading it as 0", () => {
    // `Number("")` is 0, and for one field on this screen that difference disarms a
    // configured host sweep. A blank is not a number.
    expect(parseNumberField("heartbeatSec", "")).toEqual({ ok: false, reason: "required" });
    expect(parseNumberField("staleHostRetentionDays", "   ")).toEqual({ ok: false, reason: "required" });
  });

  it("rejects a non-integer and a non-number", () => {
    expect(parseNumberField("heartbeatSec", "2.5")).toEqual({ ok: false, reason: "integer" });
    expect(parseNumberField("heartbeatSec", "soon")).toEqual({ ok: false, reason: "integer" });
  });

  it("rejects each end of the range and accepts the boundaries themselves", () => {
    expect(parseNumberField("heartbeatSec", "0")).toEqual({ ok: false, reason: "range" });
    expect(parseNumberField("heartbeatSec", "3601")).toEqual({ ok: false, reason: "range" });
    // Inclusive, exactly as the API's bounds are.
    expect(parseNumberField("heartbeatSec", "1")).toEqual({ ok: true, value: 1 });
    expect(parseNumberField("heartbeatSec", "3600")).toEqual({ ok: true, value: 3600 });
  });

  it("accepts 0 for the host sweep and only for the host sweep", () => {
    // ⚠ THE ASYMMETRY IS THE POINT. 0 is the off switch for automatic deletion, so
    // refusing it would leave a fleet that opted in with no way out; every other
    // setting treats 0 as a stale client's mistake.
    expect(parseNumberField("staleHostRetentionDays", "0")).toEqual({ ok: true, value: 0 });
    expect(parseNumberField("metricRetentionDays", "0")).toEqual({ ok: false, reason: "range" });
  });

  it("parses a list as members, not as text", () => {
    expect(parseListField(" /srv/git , ,/home/dev/code ")).toEqual(["/srv/git", "/home/dev/code"]);
    expect(parseListField("   ")).toEqual([]);
    expect(listText(["claude", "codex"])).toBe("claude, codex");
  });
});

describe("[TC-PDWEB-020] a save carries what changed, and nothing else", () => {
  const saved = settings({ heartbeatSec: 5, metricRetentionDays: 7, gitRoots: ["/srv/git"] });

  it("sends nothing at all when nothing was typed over", () => {
    expect(reviewDraft(saved, draftFrom(saved))).toEqual({ errors: {}, patch: {} });
  });

  it("sends only the field that moved", () => {
    const draft = { ...draftFrom(saved), heartbeatSec: "9" };
    expect(reviewDraft(saved, draft).patch).toEqual({ heartbeatSec: 9 });
  });

  it("does not treat re-spacing a list as a change, but does treat its members", () => {
    const respaced = { ...draftFrom(saved), gitRoots: "  /srv/git  " };
    expect(reviewDraft(saved, respaced).patch).toEqual({});
    const added = { ...draftFrom(saved), gitRoots: "/srv/git, /opt/src" };
    expect(reviewDraft(saved, added).patch).toEqual({ gitRoots: ["/srv/git", "/opt/src"] });
  });

  it("keeps a field that does not parse out of the patch, and reports it", () => {
    // ⚠ Both halves matter. Reporting without withholding would send a value the API
    // has to reject; withholding without reporting would save the rest and quietly
    // drop the field the operator was actually editing.
    const draft = { ...draftFrom(saved), heartbeatSec: "99999", metricRetentionDays: "30" };
    const review = reviewDraft(saved, draft);
    expect(review.errors).toEqual({ heartbeatSec: "range" });
    expect(review.patch).toEqual({ metricRetentionDays: 30 });
  });

  it("reads a missing staleHostRetentionDays as OFF rather than as absent", () => {
    // An API older than the field answers without it. `0` is the only safe reading:
    // anything else would make the screen claim a sweep is configured.
    const older: FleetSettingsView = { ...settings() };
    delete older.staleHostRetentionDays;
    expect(savedNumber(older, "staleHostRetentionDays")).toBe(0);
    expect(draftFrom(older).staleHostRetentionDays).toBe("0");
    expect(reviewDraft(older, draftFrom(older)).patch).toEqual({});
  });
});

describe("[TC-PDWEB-021] arming the host sweep is a decision, and it names what it takes", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  const iso = (daysAgo: number): string => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const fleet = [
    { id: "a", label: "seen-today", lastSeenAt: iso(0) },
    { id: "b", label: "quiet-40d", lastSeenAt: iso(40) },
    { id: "c", label: "quiet-9d", lastSeenAt: iso(9) },
    { id: "d", label: "never", lastSeenAt: null },
  ];

  it("counts turning it on, and shortening a window, as arming it", () => {
    expect(armsHostSweep(0, 30)).toBe(true);
    // Shortening deletes hosts immediately: the sweep runs on its next pass, so 30 → 7
    // takes everything quiet for between one and four weeks.
    expect(armsHostSweep(30, 7)).toBe(true);
    expect(armsHostSweep(30, 60)).toBe(true);
  });

  it("does not gate turning it off, or a no-op", () => {
    // ⚠ THE CONTROL. A gate on every write would pass the block above while making a
    // deletion harder to switch off than on, which is the wrong way round.
    expect(armsHostSweep(30, 0)).toBe(false);
    expect(armsHostSweep(30, 30)).toBe(false);
    expect(armsHostSweep(0, 0)).toBe(false);
  });

  it("lists exactly the hosts a window would take today", () => {
    expect(hostsPastWindow(fleet, 30, now).map((host) => host.label)).toEqual(["quiet-40d"]);
    // Shortening the window widens the list — the number the dialog has to show.
    expect(hostsPastWindow(fleet, 7, now).map((host) => host.label)).toEqual(["quiet-40d", "quiet-9d"]);
  });

  it("never lists a host that has not connected, and lists nothing while off", () => {
    // ⚠ `lastSeenAt === null` is a machine whose installer has not run yet, not one
    // that has been quiet forever. Restated here rather than left to SQL's NULL rules.
    expect(hostsPastWindow(fleet, 1, now).some((host) => host.label === "never")).toBe(false);
    expect(hostsPastWindow(fleet, 0, now)).toEqual([]);
    expect(hostsPastWindow([{ id: "x", label: "bad-clock", lastSeenAt: "not a date" }], 1, now)).toEqual([]);
  });
});

describe("[TC-PDWEB-022] the screen's bounds and its field list still match the API", () => {
  const source = readFileSync(API_SETTINGS, "utf8");

  it("reads the API's own tables at all", () => {
    // A silent zero on either side would make every comparison below vacuous.
    expect(Object.keys(apiBounds(source)).length).toBeGreaterThan(10);
    expect(Object.keys(apiDefaults(source)).length).toBeGreaterThan(10);
  });

  it("mirrors NUMBER_BOUNDS exactly", () => {
    // The mirror exists because this app cannot import a NestJS module; this is what
    // stops it from becoming a second opinion.
    expect(FLEET_NUMBER_BOUNDS).toEqual(apiBounds(source));
  });

  it("mirrors the shipped defaults, including the sweep being OFF", () => {
    expect({ ...FLEET_SETTING_FALLBACK }).toEqual(apiDefaults(source));
    // Stated on its own as well: any non-zero default would delete, on the day an
    // upgrade landed, every host already past the window.
    expect(FLEET_SETTING_FALLBACK.staleHostRetentionDays).toBe(0);
  });

  it("puts every setting on the screen exactly once", () => {
    // A setting missing from `FLEET_FIELD_GROUPS` is a setting with no way to change
    // it — the defect this whole screen exists to fix, reintroduced one field at a time.
    const grouped = FLEET_FIELD_GROUPS.flatMap((group) => group.keys);
    expect([...grouped].sort()).toEqual([...FLEET_NUMBER_KEYS, ...FLEET_LIST_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(Object.keys(apiDefaults(source)).sort());
  });
});
