import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { acceptedNotarization, appleCredentialKeys, assertAppleCredentials, parseKeychainList, signingDiagnostic, signingEnvironment, withAppleSigning } from "./apple-signing.mjs";

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
