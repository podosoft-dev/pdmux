import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { acceptedNotarization, appleCredentialKeys, assertAppleCredentials, parseKeychainList, RELEASE_STAPLER_DELAYS_MS, signingDiagnostic, signingEnvironment, staplerWithRetry, VERIFY_STAPLER_DELAYS_MS, withAppleSigning } from "./apple-signing.mjs";

describe("[TC-PDDESKTOP-009] Apple signing credential boundary", () => {
  const fixture = Object.fromEntries(appleCredentialKeys.map(key => [key, "fixture"]));
  Object.assign(fixture, { APPLE_CODESIGN_IDENTITY: "A".repeat(40), APPLE_DEVELOPER_TEAM_ID: "A123456789", APPLE_NOTARY_KEY_ID: "B123456789", APPLE_NOTARY_ISSUER_ID: "12345678-1234-1234-1234-123456789abc" });
  it("fails closed for each absent credential before creating a keychain", () => {
    expect(() => assertAppleCredentials(fixture)).not.toThrow();
    for (const key of appleCredentialKeys) expect(() => assertAppleCredentials({ ...fixture, [key]: "" })).toThrow(`Missing ${key}`);
  });
  it("removes credential contents, discovery settings, and debug logging from children", () => {
    expect(signingEnvironment({ ...fixture, PATH: "/bin", CSC_LINK: "private", CSC_NAME: "unrelated", WIN_CSC_LINK: "private", INFISICAL_TOKEN: "private", INFRA_INFISICAL_TOKEN_CACHE: "private", PDMUX_IMPORT_PASSWORD: "private", DEBUG: "*", DEBUG_DMG: "true" })).toEqual({ PATH: "/bin" });
  });
  it("reads the user keychain search list it puts the signing keychain on and restores", () => {
    const output = '    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n';
    expect(parseKeychainList(output)).toEqual(["/Users/runner/Library/Keychains/login.keychain-db", "/Library/Keychains/System.keychain"]);
    expect(parseKeychainList("")).toEqual([]);
  });
  it("names keychain and timestamp failures without echoing other output", () => {
    expect(signingDiagnostic("38AB: no identity found\n")).toBe("no identity found");
    expect(signingDiagnostic("bin: errSecInternalComponent\n")).toBe("errSecInternalComponent");
    expect(signingDiagnostic("The timestamp service is not available.")).toBe("The timestamp service is not available");
    expect(signingDiagnostic("password=secret-value")).toBe("output suppressed");
  });
  it("retries stapling and validation only while the fresh ticket is unavailable", async () => {
    const waits = [];
    const runs = (statuses, stderr = "The staple and validate action failed! Error 68.") => { const calls = []; return { calls, run: (...args) => { calls.push(args); return { status: statuses.shift(), stderr }; } }; };
    const quiet = { log: () => {} };
    const flaky = runs([68, 65, 0]);
    await staplerWithRetry("staple", "a.dmg", {}, { ...quiet, run: flaky.run, wait: async ms => { waits.push(ms); } });
    expect(flaky.calls.length).toBe(3);
    expect(flaky.calls[0].slice(0, 2)).toEqual(["xcrun", ["stapler", "staple", "a.dmg"]]);
    expect(waits).toEqual(RELEASE_STAPLER_DELAYS_MS.slice(0, 2));
    const broken = runs([1]);
    await expect(staplerWithRetry("staple", "a.dmg", {}, { ...quiet, run: broken.run, wait: async () => {} })).rejects.toThrow("xcrun/stapler staple");
    expect(broken.calls.length).toBe(1);
    const missing = runs([68, 68, 68]);
    await expect(staplerWithRetry("staple", "a.dmg", {}, { ...quiet, delaysMs: [1, 1], run: missing.run, wait: async () => {} })).rejects.toThrow("Error 68");
    expect(missing.calls.length).toBe(3);
    // The 0.17.4 Intel DMG: validate exited 68 seconds after an Accepted receipt.
    const validating = runs([68, 0], "The validate action failed! Error 68.");
    await staplerWithRetry("validate", "a.dmg", {}, { ...quiet, run: validating.run, wait: async () => {} });
    expect(validating.calls.map(call => call[1])).toEqual([["stapler", "validate", "a.dmg"], ["stapler", "validate", "a.dmg"]]);
    const invalid = runs([68, 68], "The validate action failed! Error 68.");
    await expect(staplerWithRetry("validate", "a.dmg", {}, { ...quiet, delaysMs: [1], run: invalid.run, wait: async () => {} })).rejects.toThrow("xcrun/stapler validate; The validate action failed! Error 68");
    await expect(staplerWithRetry("remove", "a.dmg", {}, { ...quiet, run: invalid.run, wait: async () => {} })).rejects.toThrow("Unsupported stapler action");
  });
  it("outlasts an Apple CloudKit outage and treats its connection loss as retryable", async () => {
    // 2026-10-19 v0.17.5 Intel: validate exhausted six tries 20 s apart in the release, and
    // the published-file check failed once on CloudKit -1005 "network connection was lost".
    const cloudKit = "Could not validate ticket for a.dmg: Error Domain=NSURLErrorDomain Code=-1005 \"The network connection was lost.\"";
    expect(RELEASE_STAPLER_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBeGreaterThanOrEqual(5 * 60_000);
    expect(RELEASE_STAPLER_DELAYS_MS.every((delay, index, all) => index === 0 || delay >= all[index - 1])).toBe(true);
    const statuses = [1, 1, 68, 0]; const calls = []; const waits = []; const logs = [];
    await staplerWithRetry("validate", "a.dmg", {}, { run: (...args) => { calls.push(args); return { status: statuses.shift(), stderr: cloudKit }; }, wait: async ms => { waits.push(ms); }, log: message => logs.push(message) });
    expect(calls.length).toBe(4);
    expect(waits).toEqual(RELEASE_STAPLER_DELAYS_MS.slice(0, 3));
    expect(logs[0]).toContain("Apple CloudKit lost its network connection (-1005)");
    const stalled = [null, 0];
    await staplerWithRetry("validate", "a.dmg", {}, { log: () => {}, run: () => { const status = stalled.shift(); return status === null ? { status, error: Object.assign(new Error("spawnSync xcrun ETIMEDOUT"), { code: "ETIMEDOUT" }) } : { status }; }, wait: async () => {} });
    expect(stalled).toEqual([]);
    expect(signingDiagnostic(`${cloudKit}\nThe validate action failed! Error 68.`)).toBe("Apple CloudKit lost its network connection (-1005); The validate action failed! Error 68");
    expect(VERIFY_STAPLER_DELAYS_MS.length).toBeGreaterThan(0);
    const verifier = readFileSync(new URL("./verify-macos-desktop.mjs", import.meta.url), "utf8");
    expect(verifier).not.toContain('execFileSync("xcrun", ["stapler"');
    expect(verifier.match(/staplerWithRetry\("validate", [a-z]+, process\.env, \{ delaysMs: VERIFY_STAPLER_DELAYS_MS \}\)/g)).toHaveLength(2);
  });
  it("cannot opt CI into the local signing entrypoint", async () => {
    await expect(withAppleSigning(() => { throw new Error("Must not run"); }, { local: true, env: { GITHUB_ACTIONS: "true" } })).rejects.toThrow("CI must use the release signing boundary");
  });
  it("requires an accepted Apple receipt, not an upload or an unfinished submission", () => {
    const receipt = { id: "12345678-1234-1234-1234-123456789abc", status: "Accepted" };
    expect(acceptedNotarization(JSON.stringify(receipt))).toEqual(receipt);
    for (const status of ["Invalid", "In Progress", "Uploaded", "Rejected"]) {
      expect(() => acceptedNotarization(JSON.stringify({ ...receipt, status }))).toThrow("did not accept");
    }
    expect(() => acceptedNotarization("not JSON")).toThrow("no JSON receipt");
    expect(() => acceptedNotarization('{"status":"Accepted"}')).toThrow("submission ID");
  });
  it("pins a Developer ID certificate without requiring custom root trust", () => {
    const certificate = new X509Certificate(readFileSync(new URL("../apps/desktop/signing-certificate.pem", import.meta.url)));
    expect(certificate.ca).toBe(false);
    expect(certificate.subject.split("\n").filter(value => value.startsWith("OU=")).length).toBe(1);
    const source = readFileSync(new URL("./apple-signing.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("add-trusted-cert");
    expect(source).not.toContain('"-P", credentials.APPLE_CERTIFICATE_PASSWORD');
  });
});
