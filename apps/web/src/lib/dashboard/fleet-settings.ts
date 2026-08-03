/**
 * The fleet settings screen's judgement, with no component wrapped around it.
 *
 * Three things live here rather than in the page, because all three are decisions
 * rather than pixels: the BOUNDS the API enforces (so a bad number is refused beside
 * the field instead of coming back as a 400 the operator has to decode), the GROUPING
 * that decides what is shown beside what, and what it MEANS to arm the host sweep.
 * Pure, so the rules that matter — out of range is refused, an unchanged form sends
 * nothing, no setting is left off the screen — are unit-tested rather than clicked at.
 *
 * ⚠ THE BOUNDS ARE A MIRROR, NOT A SECOND OPINION. The source of truth is
 * `apps/api/src/fleet/fleet-settings.ts` (`NUMBER_BOUNDS`, and `FLEET_SETTING_DEFAULTS`
 * beside it), which this app cannot import: it is a NestJS workspace and pulling it in
 * would drag decorators and TypeORM into a browser bundle (the reason `types.ts` gives
 * for restating the wire shapes). `test/fleet-settings.test.ts` READS that file and
 * fails when the two disagree, so the copy cannot drift in silence.
 */
import type { FleetSettingsView } from "./types";

/** The numeric settings, in the order the API declares them. */
export const FLEET_NUMBER_KEYS = [
  "heartbeatSec",
  "gitIntervalSec",
  "gitLimit",
  "gitDetailBudget",
  "usageIntervalSec",
  "probeTimeoutMs",
  "statusFileCap",
  "bodyMaxChars",
  "terminalBufferBytes",
  "metricStepSec",
  "metricRetentionDays",
  "staleHostRetentionDays",
] as const;
export type FleetNumberKey = (typeof FLEET_NUMBER_KEYS)[number];

/** The settings that are lists of strings — edited as one comma-separated line. */
export const FLEET_LIST_KEYS = ["gitRoots", "usageProviders"] as const;
export type FleetListKey = (typeof FLEET_LIST_KEYS)[number];

/**
 * The settings that are simply on or off.
 *
 * ⚠ THE FIRST OF ITS KIND ON THIS SCREEN, so the bounds machinery does not apply:
 * `parseNumberField` and `NUMBER_BOUNDS` are about numbers, and a checkbox has no
 * out-of-range state to refuse. It still has to be in `FLEET_FIELD_GROUPS`, because
 * a setting nobody put on the screen is a setting with no way to change it.
 */
export const FLEET_TOGGLE_KEYS = ["mcpUserTokens"] as const;
export type FleetToggleKey = (typeof FLEET_TOGGLE_KEYS)[number];

export type FleetSettingKey = FleetNumberKey | FleetListKey | FleetToggleKey;

export interface NumberBounds {
  min: number;
  max: number;
}

/**
 * Inclusive bounds, mirrored from the API (see the file comment).
 *
 * ⚠ `staleHostRetentionDays.min` is 0 and that is not a rounding of 1: 0 is the OFF
 * switch for automatic host deletion, so a screen that clamped it to 1 would turn
 * "never remove a host" into "remove every host silent for a day" — the exact accident
 * the setting exists to make impossible.
 */
export const FLEET_NUMBER_BOUNDS: Record<FleetNumberKey, NumberBounds> = {
  heartbeatSec: { min: 1, max: 3600 },
  gitIntervalSec: { min: 10, max: 86_400 },
  gitLimit: { min: 10, max: 2000 },
  gitDetailBudget: { min: 0, max: 1000 },
  usageIntervalSec: { min: 10, max: 3600 },
  probeTimeoutMs: { min: 100, max: 10_000 },
  statusFileCap: { min: 10, max: 2000 },
  bodyMaxChars: { min: 200, max: 20_000 },
  terminalBufferBytes: { min: 4096, max: 4_000_000 },
  metricStepSec: { min: 5, max: 3600 },
  metricRetentionDays: { min: 1, max: 3650 },
  staleHostRetentionDays: { min: 0, max: 3650 },
};

/**
 * The shipped defaults, mirrored from `FLEET_SETTING_DEFAULTS`.
 *
 * It is what the shell draws when `/fleet/settings` could not be read at all — and the
 * intersection is deliberate: with nothing optional, indexing this always answers, so
 * `staleHostRetentionDays` has a value to compare against rather than an `undefined`
 * that every caller would have to re-decide the meaning of.
 */
export const FLEET_SETTING_FALLBACK: FleetSettingsView & { staleHostRetentionDays: number } = {
  heartbeatSec: 5,
  gitIntervalSec: 120,
  gitRoots: [],
  gitLimit: 300,
  gitDetailBudget: 120,
  usageProviders: ["claude", "codex"],
  usageIntervalSec: 60,
  probeTimeoutMs: 2000,
  statusFileCap: 300,
  bodyMaxChars: 1200,
  terminalBufferBytes: 262_144,
  metricStepSec: 30,
  metricRetentionDays: 7,
  // 0 = never remove a host automatically, and shipping any other number would delete
  // machines nobody pointed at on the schedule of an upgrade. See the API's comment.
  staleHostRetentionDays: 0,
  // Off for the same reason as the line above: an upgrade must not hand a fleet a
  // credential shape it never asked for.
  mcpUserTokens: false,
};

export type FleetGroupId = "cadence" | "history" | "caps" | "lists" | "sweep" | "access";

export interface FleetGroup {
  id: FleetGroupId;
  keys: readonly FleetSettingKey[];
}

/**
 * What is shown beside what, ordered by blast radius rather than by the interface's
 * field order.
 *
 * Eighteen numbers in one column is a form nobody can read the consequence of, and the
 * consequences differ by kind: cadence costs the agent's time and the wire, stored
 * history costs rows on disk, caps bound one answer, and the sweep DELETES MACHINES.
 * The last one is its own group with one field in it for exactly that reason — it is
 * not "another retention number", and putting it beside `metricRetentionDays` would say
 * that it was.
 */
export const FLEET_FIELD_GROUPS: readonly FleetGroup[] = [
  { id: "cadence", keys: ["heartbeatSec", "gitIntervalSec", "usageIntervalSec", "probeTimeoutMs"] },
  { id: "history", keys: ["metricStepSec", "metricRetentionDays"] },
  { id: "caps", keys: ["gitLimit", "gitDetailBudget", "statusFileCap", "bodyMaxChars", "terminalBufferBytes"] },
  { id: "lists", keys: ["gitRoots", "usageProviders"] },
  { id: "sweep", keys: ["staleHostRetentionDays"] },
  // Its own group for the same reason the sweep has one: this is not another
  // collection knob, it decides who can reach every machine in the fleet at once.
  { id: "access", keys: ["mcpUserTokens"] },
];

/** Why a field cannot be sent. The screen turns each into a sentence beside the input. */
export type FieldError = "required" | "integer" | "range";

export type NumberInput = { ok: true; value: number } | { ok: false; reason: FieldError };

/**
 * One typed field → a number the API will accept, or the reason it will not.
 *
 * ⚠ EMPTY IS `required`, NEVER 0. `Number("")` is 0 in JavaScript, and for one field on
 * this screen that difference deletes hosts: a cleared `staleHostRetentionDays` reading
 * as 0 would silently disarm a sweep the operator had configured, and a cleared
 * `heartbeatSec` reading as 0 would be a value the API has to clamp back. A blank field
 * is not a number, so it is refused as one.
 */
export function parseNumberField(key: FleetNumberKey, raw: string): NumberInput {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "required" };
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return { ok: false, reason: "integer" };
  const bounds = FLEET_NUMBER_BOUNDS[key];
  if (value < bounds.min || value > bounds.max) return { ok: false, reason: "range" };
  return { ok: true, value };
}

/** A comma-separated line → the list the API stores. Blanks are dropped, order is kept. */
export function parseListField(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The inverse, for seeding the field. `, ` rather than `,` so a long path list wraps. */
export function listText(values: readonly string[]): string {
  return values.join(", ");
}

/** The form's own state: every setting as the TEXT being edited, valid or not yet. */
export type FleetDraft = Record<FleetSettingKey, string>;

/**
 * Seed the form from what the server last said.
 *
 * Written out field by field rather than looped, so adding a setting to the wire shape
 * fails to compile here instead of quietly rendering an empty box.
 */
export function draftFrom(settings: FleetSettingsView): FleetDraft {
  return {
    heartbeatSec: String(settings.heartbeatSec),
    gitIntervalSec: String(settings.gitIntervalSec),
    gitLimit: String(settings.gitLimit),
    gitDetailBudget: String(settings.gitDetailBudget),
    usageIntervalSec: String(settings.usageIntervalSec),
    probeTimeoutMs: String(settings.probeTimeoutMs),
    statusFileCap: String(settings.statusFileCap),
    bodyMaxChars: String(settings.bodyMaxChars),
    terminalBufferBytes: String(settings.terminalBufferBytes),
    metricStepSec: String(settings.metricStepSec),
    metricRetentionDays: String(settings.metricRetentionDays),
    staleHostRetentionDays: String(savedNumber(settings, "staleHostRetentionDays")),
    // Booleans ride as text so the draft stays one shape; the API stores them the
    // same way (`String(value)` out, `value === "true"` in).
    mcpUserTokens: String(settings.mcpUserTokens),
    gitRoots: listText(settings.gitRoots),
    usageProviders: listText(settings.usageProviders),
  };
}

/** The stored value, with the one optional field falling back to OFF (see `types.ts`). */
export function savedNumber(settings: FleetSettingsView, key: FleetNumberKey): number {
  return settings[key] ?? FLEET_SETTING_FALLBACK[key];
}

export interface DraftReview {
  /**
   * Field → why it cannot be sent. Empty means the whole form is sendable.
   *
   * Keyed by the NUMERIC settings only, because those are the only ones that can be
   * wrong: a list field accepts any text and parses to a list, so there is nothing for
   * it to fail at. Narrowing the key type here is what lets the screen look up bounds
   * for an error without a cast.
   */
  errors: Partial<Record<FleetNumberKey, FieldError>>;
  /** Only what CHANGED, so a save cannot rewrite a setting nobody touched. */
  patch: Partial<FleetSettingsView>;
}

/**
 * What this form would send, and what it refuses to.
 *
 * Two rules, and both are about not writing something nobody asked for:
 *
 * - A field that does not parse contributes an error and NOTHING to the patch. The
 *   screen then refuses the save entirely — half a form is not a saved form, and the
 *   half that went through would be the half nobody was looking at.
 * - A field equal to what the server already holds is left out. `PUT /fleet/settings`
 *   takes every field as optional and upserts only what it is given, so sending the
 *   untouched ones would stamp this browser's view over a change a colleague made
 *   between the page load and the click.
 */
export function reviewDraft(saved: FleetSettingsView, draft: FleetDraft): DraftReview {
  const errors: Partial<Record<FleetNumberKey, FieldError>> = {};
  const patch: Partial<FleetSettingsView> = {};

  for (const key of FLEET_NUMBER_KEYS) {
    const parsed = parseNumberField(key, draft[key]);
    if (!parsed.ok) {
      errors[key] = parsed.reason;
      continue;
    }
    if (parsed.value !== savedNumber(saved, key)) patch[key] = parsed.value;
  }

  for (const key of FLEET_TOGGLE_KEYS) {
    const next = draft[key] === "true";
    if (next !== saved[key]) patch[key] = next;
  }

  for (const key of FLEET_LIST_KEYS) {
    const next = parseListField(draft[key]);
    // Compared as text, so re-typing the same paths with different spacing is not a
    // change — a list only differs when its members do.
    if (listText(next) !== listText(saved[key])) patch[key] = next;
  }

  return { errors, patch };
}

/**
 * Whether saving this value opts the fleet INTO automatic host deletion.
 *
 * Any non-zero value that is not already stored counts, including SHORTENING an
 * existing window: the sweep runs on its next pass, so cutting 30 days to 7 deletes
 * every host that has been quiet for between one and four weeks, immediately. Going to
 * `0` is the only direction that destroys nothing, and it is deliberately not gated —
 * turning a deletion off must never be harder than turning it on.
 */
export function armsHostSweep(saved: number, next: number): boolean {
  return next > 0 && next !== saved;
}

/** The part of a host this file needs; `HostView` satisfies it. */
export interface SweepCandidate {
  id: string;
  label: string;
  lastSeenAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which hosts the next sweep would take at this window — the answer the confirmation
 * dialog shows before anyone agrees to it.
 *
 * ⚠ `lastSeenAt === null` IS NEVER SWEPT, and this restates the server's rule rather
 * than relying on it: a NULL is a host registered minutes ago whose installer has not
 * run yet, not a machine that has been quiet for years. The server's `lastSeenAt <
 * cutoff` excludes it because SQL comparisons drop NULLs, but "we depended on the null
 * semantics of a comparison" and "we decided this" are different things, and only the
 * second one survives a rewrite of the query.
 */
export function hostsPastWindow(
  hosts: readonly SweepCandidate[],
  retentionDays: number,
  now: number,
): SweepCandidate[] {
  if (retentionDays <= 0) return [];
  return hosts.filter((host) => {
    if (host.lastSeenAt === null) return false;
    const days = (now - Date.parse(host.lastSeenAt)) / DAY_MS;
    // An unparsable timestamp is not a claim we can make about the machine.
    if (!Number.isFinite(days)) return false;
    return days > retentionDays;
  });
}
