import { describe, expect, it } from "@jest/globals";
import {
  ENROLLMENT_CODE_PREFIX,
  canonicalizeEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
  mintEnrollmentCode,
} from "./agent-enrollment.crypto";
import { AGENT_TOKEN_PREFIX } from "./agent-token.crypto";

const CANONICAL = /^pdmxe_[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

describe("[TC-PDAGENT-062] enrollment code format", () => {
  it("mints a canonical, dashed, 100-bit code that round-trips through canonicalisation", () => {
    for (let i = 0; i < 50; i += 1) {
      const { code, codeHash } = mintEnrollmentCode();
      expect(code).toMatch(CANONICAL);
      // What we mint is already canonical — the redemption path hashes the same
      // string the operator was shown.
      expect(canonicalizeEnrollmentCode(code)).toBe(code);
      expect(codeHash).toBe(hashEnrollmentCode(code));
      expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("never emits a confusable letter, and never a shell metacharacter", () => {
    const body = Array.from({ length: 200 }, () => mintEnrollmentCode().code)
      .map((code) => code.slice(ENROLLMENT_CODE_PREFIX.length).replace(/-/g, ""))
      .join("");
    expect(body).not.toMatch(/[ILOU]/);
    // The installer takes it unquoted: `sh -s -- --code pdmxe_…`.
    expect(body).not.toMatch(/[^0-9A-Z]/);
  });

  it("draws symbols uniformly — no modulo bias", () => {
    const counts = new Map<string, number>();
    const samples = 3000;
    for (let i = 0; i < samples; i += 1) {
      for (const char of mintEnrollmentCode().code.slice(ENROLLMENT_CODE_PREFIX.length).replace(/-/g, "")) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    // All 32 symbols reachable, none of them favoured. With 60,000 draws the
    // expected share is 1/32; a `% 32` over a non-power-of-two alphabet (or an
    // off-by-one slice of the alphabet string) lands far outside this band.
    expect(counts.size).toBe(32);
    const expected = (samples * 20) / 32;
    for (const [symbol, count] of counts) {
      expect({ symbol, ok: count > expected * 0.8 && count < expected * 1.2 }).toEqual({ symbol, ok: true });
    }
  });

  it("canonicalises the ways a human retypes a code", () => {
    const code = "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW";
    const variants = [
      code,
      code.toLowerCase(),
      code.toUpperCase(), // including the prefix
      code.replace(/-/g, ""), // no dashes
      `  ${code}  `, // pasted with padding
      code.replace(/-/g, " "), // dashes read as spaces
      "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW\n", // trailing newline from a copy
    ];
    for (const variant of variants) expect(canonicalizeEnrollmentCode(variant)).toBe(code);
  });

  it("maps the confusable characters back instead of inventing a different code", () => {
    // O -> 0 and I/L -> 1: a misread cannot become a *different valid* code.
    const printed = "pdmxe_7Q4K0-9XZRB-8C3TF-N5HV1";
    const misread = "pdmxe_7q4kO-9xzrb-8c3tf-n5hvl"; // O for zero, l for one, lower case
    expect(canonicalizeEnrollmentCode(misread)).toBe(printed);
    expect(canonicalizeEnrollmentCode("pdmxe_1BCDE-FGHJK-MNPQR-STVWX")).toBe("pdmxe_1BCDE-FGHJK-MNPQR-STVWX");
    expect(canonicalizeEnrollmentCode("pdmxe_IBCDE-FGHJK-MNPQR-STVWX")).toBe("pdmxe_1BCDE-FGHJK-MNPQR-STVWX");
    expect(canonicalizeEnrollmentCode("pdmxe_lBCDE-FGHJK-MNPQR-STVWX")).toBe("pdmxe_1BCDE-FGHJK-MNPQR-STVWX");
    expect(canonicalizeEnrollmentCode("pdmxe_0BCDE-FGHJK-MNPQR-STVWX")).toBe("pdmxe_0BCDE-FGHJK-MNPQR-STVWX");
    expect(canonicalizeEnrollmentCode("pdmxe_OBCDE-FGHJK-MNPQR-STVWX")).toBe("pdmxe_0BCDE-FGHJK-MNPQR-STVWX");
  });

  it("rejects everything that is not a code", () => {
    const rejected: unknown[] = [
      "",
      "   ",
      null,
      undefined,
      42,
      { code: "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW" },
      "7Q4KM-9XZRB-8C3TF-N5HVW", // no prefix
      `${AGENT_TOKEN_PREFIX}7Q4KM9XZRB8C3TFN5HVW`, // a token is not a code
      "pdmxe_7Q4KM-9XZRB-8C3TF-N5HV", // 19 symbols
      "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVWW", // 21 symbols
      "pdmxe_UQ4KM-9XZRB-8C3TF-N5HVW", // U is outside Crockford's alphabet
      "pdmxe_7Q4KM-9XZRB-8C3TF-N5HV$", // shell metacharacter
      "pdmxe_7Q4KM_9XZRB_8C3TF_N5HVW", // underscores are not dashes
    ];
    for (const value of rejected) {
      expect({ value, result: canonicalizeEnrollmentCode(value) }).toEqual({ value, result: null });
    }
  });

  it("masks to a hint that is not the code", () => {
    const { code } = mintEnrollmentCode();
    const masked = maskEnrollmentCode(code);
    expect(masked.startsWith(ENROLLMENT_CODE_PREFIX)).toBe(true);
    expect(masked).not.toBe(code);
    expect(code).not.toContain(masked);
    expect(canonicalizeEnrollmentCode(masked)).toBeNull();
  });

  it("uses a prefix that cannot be confused with a token's", () => {
    expect(ENROLLMENT_CODE_PREFIX).not.toBe(AGENT_TOKEN_PREFIX);
    expect(mintEnrollmentCode().code.startsWith(AGENT_TOKEN_PREFIX)).toBe(false);
  });

  it("mints a distinct code every time", () => {
    const codes = new Set(Array.from({ length: 500 }, () => mintEnrollmentCode().code));
    expect(codes.size).toBe(500);
  });
});
