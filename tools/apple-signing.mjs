import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const appleCredentialKeys = [
  "APPLE_CERTIFICATE_P12_BASE64", "APPLE_CERTIFICATE_PASSWORD", "APPLE_CODESIGN_IDENTITY",
  "APPLE_DEVELOPER_ID_G2_CERT_BASE64", "APPLE_DEVELOPER_TEAM_ID",
  "APPLE_NOTARY_ISSUER_ID", "APPLE_NOTARY_KEY_ID", "APPLE_NOTARY_KEY_P8_BASE64",
];

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
  assert.ok(Date.parse(certificate.validFrom) <= Date.now(), "Signing certificate is not valid yet");
  assert.ok(Date.parse(certificate.validTo) > Date.now(), "Signing certificate has expired");
  return certificate;
}

export function assertAppleCredentials(env) {
  for (const key of appleCredentialKeys) assert.ok(env[key]?.trim(), `Missing ${key}`);
  assert.match(env.APPLE_CODESIGN_IDENTITY, /^[A-Fa-f0-9]{40}$/, "Require a certificate SHA-1 identity");
  assert.match(env.APPLE_DEVELOPER_TEAM_ID, /^[A-Z0-9]{10}$/, "Invalid Apple team ID");
  assert.match(env.APPLE_NOTARY_KEY_ID, /^[A-Z0-9]{10}$/, "Invalid notary key ID");
  assert.match(env.APPLE_NOTARY_ISSUER_ID, /^[a-f0-9-]{36}$/i, "Invalid notary issuer ID");
}

export function acceptedNotarization(output) {
  let receipt;
  try { receipt = JSON.parse(output); }
  catch { throw new Error("Apple notarization returned no JSON receipt"); }
  assert.equal(receipt.status, "Accepted", "Apple notarization did not accept the submission");
  assert.match(receipt.id ?? "", /^[a-f0-9-]{36}$/i, "Missing Apple notarization submission ID");
  return receipt;
}

export function signingEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(APPLE_|CSC_|WIN_CSC_|INFISICAL_|INFRA_INFISICAL_|PDMUX_IMPORT_)/.test(key)
      && key !== "DEBUG" && key !== "DEBUG_DMG"));
}

// Child output is intentionally captured: keychain tools can echo identities and
// arguments. Errors expose the operation only, never credential-bearing output.
export function signingDiagnostic(stderr) {
  if (/MAC verification failed/.test(stderr)) return "PKCS12 integrity verification failed";
  if (/User interaction is not allowed/.test(stderr)) return "keychain interaction unavailable";
  if (/One or more parameters/.test(stderr)) return "unsupported keychain import parameters";
  const known = stderr.match(/CSSMERR_[A-Z_]+|errSec[A-Za-z]+|no identity found|The (?:staple and )?validate action failed! Error -?\d+|The timestamp service is not available|code failed to satisfy specified code requirement\(s\)|code object is not signed at all|invalid signature|main executable failed strict validation|unable to build chain to self-signed root|a sealed resource is missing or invalid|code or signature have been modified/)?.[0];
  const cloudKit = CLOUDKIT_CONNECTION_LOST.test(stderr) ? "Apple CloudKit lost its network connection (-1005)" : undefined;
  return [cloudKit, known].filter(Boolean).join("; ") || "output suppressed";
}

const CLOUDKIT_CONNECTION_LOST = /NSURLErrorDomain Code=-1005|network connection was lost/i;

/** Waits between stapler attempts while signing a release: about eight minutes in all. */
export const RELEASE_STAPLER_DELAYS_MS = [20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 120_000];
/** Waits per stapler call when verifying finished packages, whose job has a shorter timeout. */
export const VERIFY_STAPLER_DELAYS_MS = [15_000, 30_000];

function retryableStapler(result) {
  if ([65, 68].includes(result.status)) return true;
  if (result.error?.code === "ETIMEDOUT") return true;
  return CLOUDKIT_CONNECTION_LOST.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

/**
 * Runs `xcrun stapler staple` or `validate`. Right after Apple accepts a submission
 * its CDN can still lack the ticket, and stapler exits 65 or 68: the 0.17.1 macOS
 * Intel DMG failed `staple` that way 7 s after an Accepted receipt, and the 0.17.2 and
 * 0.17.4 Intel DMGs failed `validate` 7-8 s after one. Apple's CloudKit ticket lookup
 * also drops its connection (`NSURLErrorDomain -1005`) for minutes at a time: on
 * 2026-10-19 the 0.17.5 Intel DMG exhausted six tries 20 s apart, and the published
 * file check failed once. Those failures, and a lookup that stalls past the timeout,
 * are retried on a growing schedule.
 */
export async function staplerWithRetry(action, path, env, { delaysMs = RELEASE_STAPLER_DELAYS_MS, run = spawnSync, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = message => console.warn(message) } = {}) {
  assert.ok(["staple", "validate"].includes(action), `Unsupported stapler action ${action}`);
  for (let attempt = 0; ; attempt++) {
    const result = run("xcrun", ["stapler", action, path], { encoding: "utf8", timeout: 60_000, env });
    if (result.status === 0) return;
    const delay = delaysMs[attempt];
    const diagnostic = signingDiagnostic(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
    if (delay === undefined || !retryableStapler(result)) {
      assert.equal(result.status, 0, `Apple signing operation failed: xcrun/stapler ${action}; ${diagnostic}`);
    }
    log(`Retry xcrun stapler ${action} in ${delay / 1000} s after attempt ${attempt + 1} failed: ${diagnostic}`);
    await wait(delay);
  }
}

/** Keychain paths from `security list-keychains` output, one quoted path per line. */
export function parseKeychainList(output) {
  return output.split("\n").map(line => line.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

export function signingCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
  const diagnostic = signingDiagnostic(result.stderr ?? "");
  assert.equal(result.status, 0, `Apple signing operation failed: ${command}/${args[0]}; ${diagnostic}`);
  return result.stdout;
}

export async function withAppleSigning(callback, { local = false, env = process.env } = {}) {
  if (local) assert.notEqual(env.GITHUB_ACTIONS, "true", "CI must use the release signing boundary");
  else assertReleaseContext(env);
  assert.equal(process.platform, "darwin", "Apple signing requires native macOS");
  assertAppleCredentials(env);
  const credentials = Object.fromEntries(appleCredentialKeys.map(key => [key, env[key]]));
  const clean = signingEnvironment(env);
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-apple-signing-"));
  const keychain = join(temporary, "signing.keychain-db");
  const keychainPassword = randomBytes(32).toString("hex");
  let created = false;
  let searchList;
  try {
    const archive = Buffer.from(credentials.APPLE_CERTIFICATE_P12_BASE64, "base64");
    const passwordEnv = { ...clean, PDMUX_IMPORT_PASSWORD: credentials.APPLE_CERTIFICATE_PASSWORD };
    const decodeArgs = ["pkcs12", "-nodes", "-passin", "env:PDMUX_IMPORT_PASSWORD"];
    let decoded;
    try { decoded = signingCommand("openssl", decodeArgs, { input: archive, env: passwordEnv }); }
    catch { decoded = signingCommand("openssl", ["pkcs12", "-legacy", ...decodeArgs.slice(1)], { input: archive, env: passwordEnv }); }
    const certificate = assertCertificate(decoded, await readFile(new URL("../apps/desktop/signing-certificate.pem", import.meta.url)));
    assert.ok(certificate.checkPrivateKey(createPrivateKey(decoded)), "Certificate and private key do not match");
    assert.equal(certificate.fingerprint.replaceAll(":", ""), credentials.APPLE_CODESIGN_IDENTITY.toUpperCase(), "Certificate identity mismatch");
    const teamId = credentials.APPLE_DEVELOPER_TEAM_ID;
    assert.ok(certificate.subject.split("\n").includes(`OU=${teamId}`), "Certificate team mismatch");
    const intermediateBytes = Buffer.from(credentials.APPLE_DEVELOPER_ID_G2_CERT_BASE64, "base64");
    const intermediate = new X509Certificate(intermediateBytes);
    assert.ok(certificate.checkIssued(intermediate) && certificate.verify(intermediate.publicKey), "Invalid Developer ID certificate chain");
    const certificateDetails = signingCommand("openssl", ["x509", "-text", "-noout"], { input: certificate.toString(), env: clean });
    assert.ok(certificateDetails.includes("1.2.840.113635.100.6.1.13"), "Require a Developer ID Application certificate");

    // Rewrap in a private temporary directory with a one-use import password.
    // The vault's P12 password never becomes a security(1) command argument.
    const p12 = join(temporary, "import.p12");
    const importPassword = randomBytes(32).toString("hex");
    const decodedPath = join(temporary, "decoded.pem");
    await writeFile(decodedPath, decoded, { mode: 0o600 });
    signingCommand("openssl", ["pkcs12", "-export", "-in", decodedPath, "-inkey", decodedPath, "-out", p12, "-passout", "env:PDMUX_TEMP_PASSWORD", "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"], { env: { ...clean, PDMUX_TEMP_PASSWORD: importPassword } });
    await chmod(p12, 0o600);
    await rm(decodedPath);
    decoded = undefined;
    const intermediatePath = join(temporary, "intermediate.pem");
    await writeFile(intermediatePath, intermediate.toString(), { mode: 0o600 });
    const notaryKey = join(temporary, "notary.p8");
    const keyBytes = Buffer.from(credentials.APPLE_NOTARY_KEY_P8_BASE64, "base64");
    assert.equal(createPrivateKey(keyBytes).asymmetricKeyType, "ec", "Require an App Store Connect API key");
    await writeFile(notaryKey, keyBytes, { mode: 0o600 });
    signingCommand("security", ["create-keychain", "-p", keychainPassword, keychain], { env: clean });
    created = true;
    signingCommand("security", ["set-keychain-settings", "-lut", "7200", keychain], { env: clean });
    signingCommand("security", ["unlock-keychain", "-p", keychainPassword, keychain], { env: clean });
    signingCommand("security", ["import", intermediatePath, "-k", keychain], { env: clean });
    signingCommand("security", ["import", p12, "-k", keychain, "-P", importPassword, "-T", "/usr/bin/codesign"], { env: clean });
    await rm(p12);
    // Only this short-lived keychain password is passed to security(1).
    signingCommand("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain], { env: clean });
    // codesign finds the identity only in a keychain on the user search list, even with
    // --keychain: on the macos-26 runner it otherwise fails with "no identity found".
    searchList = parseKeychainList(signingCommand("security", ["list-keychains", "-d", "user"], { env: clean }));
    signingCommand("security", ["list-keychains", "-d", "user", "-s", keychain, ...searchList.filter(path => path !== keychain)], { env: clean });
    const identity = certificate.fingerprint.replaceAll(":", "");
    const childEnv = {
      ...clean, CSC_KEYCHAIN: keychain, CSC_IDENTITY_AUTO_DISCOVERY: "false",
      PDMUX_MAC_SIGNING_IDENTITY: identity,
      APPLE_API_KEY: notaryKey, APPLE_API_KEY_ID: credentials.APPLE_NOTARY_KEY_ID,
      APPLE_API_ISSUER: credentials.APPLE_NOTARY_ISSUER_ID,
    };
    const context = {
      env: childEnv, identity, teamId, certificateSha256: certificate.fingerprint256,
      async notarize(path) {
        const started = Date.now();
        console.log(JSON.stringify({ stage: "notarization-submit", file: path.split("/").pop() }));
        const output = signingCommand("xcrun", ["notarytool", "submit", path, "--key", notaryKey,
          "--key-id", credentials.APPLE_NOTARY_KEY_ID, "--issuer", credentials.APPLE_NOTARY_ISSUER_ID,
          "--wait", "--timeout", "20m", "--output-format", "json"], { env: clean, timeout: 1_260_000 });
        const result = acceptedNotarization(output);
        console.log(JSON.stringify({ stage: "notarization", id: result.id, status: result.status, seconds: Math.round((Date.now() - started) / 1000) }));
        return result;
      },
      sign(path) {
        signingCommand("codesign", ["--force", "--sign", identity, "--keychain", keychain, "--options", "runtime", "--timestamp", path], { env: clean });
      },
    };
    return await callback(context);
  } finally {
    try { if (searchList) signingCommand("security", ["list-keychains", "-d", "user", "-s", ...searchList], { env: clean }); }
    finally {
      try { if (created) signingCommand("security", ["delete-keychain", keychain], { env: clean }); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
}
