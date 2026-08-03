/**
 * Server error codes → the sentence the operator reads.
 *
 * ONE MAP, BECAUSE THE BRANCHES ARE THE CONTRACT. The API answers with a stable code
 * plus prose, and the app branches on the code and never on the message (AGENTS.md) —
 * so every screen that can be answered `FORBIDDEN` or `HOST_NOT_FOUND` has to agree
 * about what those mean. Written per screen they drift, and there are now three
 * screens that can hit exactly these four outcomes: the host list, the install
 * dialog, and the sidebar's own add/remove.
 *
 * A code this does not know deliberately falls through to the generic wording rather
 * than showing the code: an unrecognised failure is not more actionable in English
 * with a `SNAKE_CASE` token in it.
 */
import type { Messages } from "$lib/i18n/messages";
import { errorCode } from "./api";

/** For a code already in hand — a recorded one, e.g. the feed's last failure. */
export function codeMessage(code: string | null, t: Messages): string {
  if (code === "FORBIDDEN") return t.dash.error.forbidden;
  if (code === "HOST_NOT_FOUND") return t.dash.error.notFound;
  if (code === "NETWORK_ERROR") return t.dash.error.offline;
  return t.dash.error.generic;
}

/** The same map, straight from a thrown cause. */
export function causeMessage(cause: unknown, t: Messages): string {
  return codeMessage(errorCode(cause), t);
}
