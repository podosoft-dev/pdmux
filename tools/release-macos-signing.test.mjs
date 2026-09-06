import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { assertReleaseContext, assertCertificate } from "./release-macos-signing.mjs";

describe("[TC-PDDESKTOP-009] production signing boundary", () => {
  const valid = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.12.2", GITHUB_REF_NAME: "v0.12.2", GITHUB_REPOSITORY: "podosoft-dev/pdmux", PDMUX_SIGNING_SOURCE_REF: "v0.12.2" };
  it("accepts only the running release tag from this repository", () => {
    expect(() => assertReleaseContext(valid)).not.toThrow();
    for (const override of [
      { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_EVENT_NAME: "pull_request_target" }, { GITHUB_REF: "refs/heads/main" },
      { GITHUB_REPOSITORY: "example/fork" }, { PDMUX_SIGNING_SOURCE_REF: "main" },
    ]) expect(() => assertReleaseContext({ ...valid, ...override })).toThrow();
  });
  it("pins the checked-in public certificate and rejects malformed certificates", () => {
    const pem = readFileSync(new URL("../apps/desktop/signing-certificate.pem", import.meta.url));
    expect(assertCertificate(pem, pem).subject).toContain("pdmux Desktop Signing");
    expect(() => assertCertificate("not a certificate", pem)).toThrow();
    expect(() => assertCertificate(pem, rootCertificates[0])).toThrow("Unexpected signing certificate");
  });
});
