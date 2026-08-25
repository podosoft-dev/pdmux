import { randomBytes } from "node:crypto";
import { sha256Hex } from "./agent-token.crypto";

/**
 * The short-lived code the public installer carries:
 *
 *   curl -fsSL https://pdmux.example/install.sh | sh -s -- --code pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW
 *
 * WHY A CODE AND NOT THE TOKEN: that one-liner is pasted into chat, kept in shell
 * history and photographed off a screen. A host token is long-lived, so any of
 * those copies stays a fleet credential forever; a code is single-use and expires
 * in minutes, and the installer trades it for the real token over TLS.
 *
 * Kept free of the HTTP framework and TypeORM, like agent-token.crypto.ts, so the format rules
 * can be unit-tested directly.
 */

/** Distinct from `pdmux_` on purpose: a human never has to work out which of the
 *  two strings they are holding, and grepping logs for a leaked token does not
 *  drown in codes. */
export const ENROLLMENT_CODE_PREFIX = "pdmxe_";

/**
 * Crockford base32 — no `I`, `L`, `O`, `U`.
 *
 * WHY THIS ALPHABET: the code is read off a screen and typed on another machine.
 * Excluding the confusable letters means a misread `0`/`O` or `1`/`l` cannot
 * produce a *different valid code* — it produces something that canonicalises
 * back to the same code, or nothing at all. It is also free of shell
 * metacharacters, which matters because the installer takes it unquoted
 * (`sh -s -- --code …`).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Anything outside the alphabet (notably I, L, O, U) fails this. */
const BODY_PATTERN = /^[0-9A-HJKMNP-TV-Z]+$/;

const GROUP_SIZE = 5;
const GROUP_COUNT = 4;
/** 20 symbols x 5 bits = 100 bits. Online guessing is not a threat model. */
const BODY_LENGTH = GROUP_SIZE * GROUP_COUNT;

/** Dashes are cosmetic — they exist so a human can read the code back aloud. */
function group(body: string): string {
  const groups: string[] = [];
  for (let at = 0; at < body.length; at += GROUP_SIZE) groups.push(body.slice(at, at + GROUP_SIZE));
  return groups.join("-");
}

/**
 * WHY `& 0x1f` AND NOT `% 32`: masking takes the low 5 bits of a uniform byte,
 * and 256 is a multiple of 32, so every symbol is equally likely. A modulo over
 * an alphabet whose size does not divide 256 (36, say) silently favours the first
 * few symbols — the classic biased-token bug. Keep the alphabet at 32 or this
 * argument stops holding.
 */
export function mintEnrollmentCode(): { code: string; codeHash: string } {
  const bytes = randomBytes(BODY_LENGTH);
  let body = "";
  for (const byte of bytes) body += ALPHABET[byte & 0x1f];
  const code = `${ENROLLMENT_CODE_PREFIX}${group(body)}`;
  return { code, codeHash: sha256Hex(code) };
}

/**
 * The single entry point for "what did the user actually give us".
 *
 * Typed with spaces, in lower case, without the dashes, or with an `O` where a
 * zero was meant — all of those are the same code, so they must all hash the
 * same. Normalising here (and hashing only the canonical form) keeps that as one
 * code path instead of a family of near-miss lookups.
 *
 * Returns null for anything that is not a well-formed code; the caller answers
 * that exactly as it answers an unknown code, so the two are indistinguishable
 * from outside.
 */
export function canonicalizeEnrollmentCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/[\s-]+/g, "");
  if (!compact.toLowerCase().startsWith(ENROLLMENT_CODE_PREFIX)) return null;
  const body = compact
    .slice(ENROLLMENT_CODE_PREFIX.length)
    .toUpperCase()
    // Crockford's decode mapping. `U` has no mapping and stays invalid.
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (body.length !== BODY_LENGTH) return null;
  if (!BODY_PATTERN.test(body)) return null;
  return `${ENROLLMENT_CODE_PREFIX}${group(body)}`;
}

/** sha256 of the canonical form — never of the raw input. */
export function hashEnrollmentCode(canonical: string): string {
  return sha256Hex(canonical);
}

/** What an operator may see after creation. The full code is shown once and is
 *  unrecoverable afterwards, exactly like a token. */
export function maskEnrollmentCode(code: string): string {
  return `${ENROLLMENT_CODE_PREFIX}…${code.slice(-GROUP_SIZE)}`;
}
