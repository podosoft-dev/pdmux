import { describe, expect, it } from "bun:test";
import { commitDetailKey, isValidSha, workingDiffKey } from "./git-storage";

const HOST = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";

describe("[TC-PDGIT-003] git object keys", () => {
  it("scopes every object under its host and repo", () => {
    expect(commitDetailKey(HOST, REPO, "abcdef1234567890")).toBe(
      `hosts/${HOST}/repos/${REPO}/abcdef1234567890.json`,
    );
    expect(workingDiffKey(HOST, REPO)).toBe(`hosts/${HOST}/repos/${REPO}/working.json`);
  });

  it("refuses anything that could escape the prefix", () => {
    expect(() => commitDetailKey(HOST, REPO, "../../etc/passwd")).toThrow();
    expect(() => commitDetailKey(HOST, REPO, "abc")).toThrow(); // too short to be a sha
    expect(() => commitDetailKey(HOST, REPO, "ABCDEF1234567890")).toThrow(); // git shas are lowercase hex
    expect(() => commitDetailKey("..", REPO, "abcdef1234567890")).toThrow();
    expect(() => workingDiffKey(HOST, "../other")).toThrow();
  });

  it("validates sha shape independently", () => {
    expect(isValidSha("abcdef1")).toBe(true);
    expect(isValidSha("a".repeat(40))).toBe(true);
    expect(isValidSha("a".repeat(41))).toBe(false);
    expect(isValidSha("zzzzzzz")).toBe(false);
  });
});
