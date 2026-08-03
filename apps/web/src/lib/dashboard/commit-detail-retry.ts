/**
 * When to ask again for a commit's patch, and when to stop.
 *
 * WHY IT IS A PURE FUNCTION. The two failure modes look identical on screen — no patch —
 * and are opposites underneath. `pending > 0` means the server asked the host agent for
 * this sha and the answer is in flight, so polling ends in success. `pending: 0` means
 * nobody was asked (host offline, or the agent answered without it), so polling is a
 * guaranteed-useless request every few hundred milliseconds for as long as the panel
 * stays open. Deciding that once, in a function with no clock and no network, is what
 * makes both cases assertable and keeps the caller from having to be clever.
 *
 * WHY IT IS HERE AND NOT IN `@pdmux/core`. `@pdmux/core` owns judgement that has to
 * behave identically in the app, in a server render and in `@pdmux/ui` — the shared
 * vocabulary, `PendingNote`, is there for exactly that reason. A retry budget for one
 * app's HTTP endpoint is not shared judgement; it is transport policy, and this repo
 * already keeps that in the app: `terminal-relay.ts` owns `retryBaseMs`/`retryMaxMs` for
 * the socket the same way.
 *
 * Every function here is total: junk in yields the answer that costs nothing.
 */

export interface DetailRetryLimits {
  /** The first wait, doubled on every further attempt. */
  baseMs: number;
  /** Cap for a single wait — a long collection must not stretch to minutes between polls. */
  maxMs: number;
  /** How many polls follow the first answer before we stop asking. */
  attempts: number;
}

/**
 * Default schedule: 500ms, 1s, 2s, then 4s × 4 — a 19.5s ceiling over 7 polls.
 *
 * The click itself is what makes the server ask the agent for the patch, and on a healthy
 * host the answer lands through the ordinary ingest path a second or two later. So the
 * first two polls cover the common case and the cap keeps the tail cheap when the host is
 * busy. No jitter, deliberately: this is one person's click, not a fleet of tabs
 * reconnecting after a server restart, and a deterministic schedule is one a test can
 * assert exactly.
 */
export const DETAIL_RETRY: DetailRetryLimits = { baseMs: 500, maxMs: 4000, attempts: 7 };

export type DetailRetryStep =
  /** The patch is here — stop. */
  | { kind: "arrived" }
  /** Nobody is collecting it — never poll, and say so with the wording that already exists. */
  | { kind: "missing" }
  /** It was coming and did not arrive inside the ceiling — hand the decision back to the user. */
  | { kind: "exhausted" }
  | { kind: "retry"; delayMs: number; attempt: number };

/**
 * What to do with one answer to "give me this commit's patch".
 *
 * @param attempt how many retries have already been made (0 for the first answer)
 */
export function detailRetry(
  response: unknown,
  attempt: unknown,
  limits: DetailRetryLimits = DETAIL_RETRY,
): DetailRetryStep {
  const answer = (response ?? {}) as { available?: unknown; pending?: unknown };
  if (answer.available === true) return { kind: "arrived" };
  const pending =
    typeof answer.pending === "number" && Number.isFinite(answer.pending) ? Math.max(0, answer.pending) : 0;
  if (pending <= 0) return { kind: "missing" };
  const made = typeof attempt === "number" && Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const budget = Math.max(0, Math.floor(limits.attempts));
  if (made >= budget) return { kind: "exhausted" };
  const delayMs = Math.min(Math.max(0, limits.maxMs), Math.max(0, limits.baseMs) * 2 ** made);
  return { kind: "retry", delayMs, attempt: made + 1 };
}

/** Longest a caller can spend polling before `exhausted` — the number to put in a doc. */
export function detailRetryCeilingMs(limits: DetailRetryLimits = DETAIL_RETRY): number {
  let total = 0;
  for (let made = 0; made < Math.max(0, Math.floor(limits.attempts)); made++) {
    total += Math.min(Math.max(0, limits.maxMs), Math.max(0, limits.baseMs) * 2 ** made);
  }
  return total;
}
