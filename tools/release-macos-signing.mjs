import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageMac } from "./package-macos-desktop.mjs";

export function assertReleaseContext(env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Production signing requires a release runner");
  assert.ok(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME), "PRs cannot use production signing");
  assert.match(env.GITHUB_REF ?? "", /^refs\/tags\/v\d+\.\d+\.\d+$/, "Production signing requires a release tag");
  assert.equal(env.GITHUB_REPOSITORY, "podosoft-dev/pdmux", "Unexpected release repository");
  assert.equal(env.PDMUX_SIGNING_SOURCE_REF, env.GITHUB_REF_NAME, "Signing source must equal the running release tag");
}

export function assertCertificate(actual, expected) {
  const certificate = new X509Certificate(actual);
  assert.equal(certificate.fingerprint256, new X509Certificate(expected).fingerprint256, "Unexpected signing certificate; refusing identity rotation");
  assert.ok(Date.parse(certificate.validTo) > Date.now(), "Signing certificate has expired");
  return certificate;
}

export async function releaseMac() {
  assertReleaseContext(process.env);
  assert.equal(process.platform, "darwin");
  const archive = process.env.DESKTOP_MAC_P12;
  const password = process.env.DESKTOP_MAC_PASSWORD;
  delete process.env.DESKTOP_MAC_P12;
  delete process.env.DESKTOP_MAC_PASSWORD;
  assert.ok(archive && password, "Release signing credentials are required");
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-release-signing-"));
  const keychain = join(temporary, "release.keychain-db");
  const keychainPassword = randomBytes(32).toString("hex");
  // security requires password arguments. Capture all output and never include
  // those arguments in exceptions; this isolated release VM is discarded.
  const run = (command, args, env = process.env) => {
    const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `Release signing ${command}/${args[0]} failed; sensitive output suppressed`);
    return result.stdout;
  };
  const previous = run("security", ["list-keychains", "-d", "user"]).split("\n").map(line => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  let created = false;
  try {
    const p12 = join(temporary, "identity.p12");
    const certificatePath = join(temporary, "certificate.pem");
    await writeFile(p12, Buffer.from(archive, "base64"), { mode: 0o600 });
    const pem = run("openssl", ["pkcs12", "-in", p12, "-clcerts", "-nokeys", "-passin", "env:PDMUX_IMPORT_PASSWORD"], { ...process.env, PDMUX_IMPORT_PASSWORD: password });
    const certificate = assertCertificate(pem, await readFile(new URL("../apps/desktop/signing-certificate.pem", import.meta.url), "utf8"));
    await writeFile(certificatePath, certificate.toString(), { mode: 0o600 });
    run("security", ["create-keychain", "-p", keychainPassword, keychain]);
    created = true;
    run("security", ["set-keychain-settings", "-lut", "1800", keychain]);
    run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    run("security", ["list-keychains", "-d", "user", "-s", ...previous, keychain]);
    run("security", ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
    run("sudo", ["-n", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificatePath]);
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
    process.env.CSC_KEYCHAIN = keychain;
    process.env.PDMUX_MAC_SIGNING_IDENTITY = "pdmux Desktop Signing";
    await packageMac();
    console.log(JSON.stringify({ stage: "release-signing", fingerprint: certificate.fingerprint256, result: "passed" }));
  } finally {
    delete process.env.CSC_KEYCHAIN;
    delete process.env.PDMUX_MAC_SIGNING_IDENTITY;
    try {
      if (created) {
        run("security", ["list-keychains", "-d", "user", "-s", ...previous]);
        run("security", ["delete-keychain", keychain]);
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

if (import.meta.main) await releaseMac();
