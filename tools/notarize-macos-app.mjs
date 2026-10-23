import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedNotarization, signingCommand, staplerWithRetry } from "./apple-signing.mjs";

/**
 * electron-builder `afterSign` hook for release packaging. It replaces the builder's
 * own notarization, whose `@electron/notarize` staple retries three times within
 * seconds: the 0.17.10 macOS Intel app failed there twice with stapler 68 and
 * CloudKit `-1005`, before `staplerWithRetry` could ever run. Submitting here keeps
 * the same order (sign, notarize, staple, then build the DMG and ZIP from the stapled
 * app) and gives the app staple the release retry schedule the DMG already has.
 */
export async function notarizeMacApp(appPath, env, {
  command = signingCommand,
  stapler = staplerWithRetry,
  temporaryRoot = tmpdir(),
  log = message => console.log(message),
} = {}) {
  for (const key of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
    if (!env[key]) throw new Error(`Notarization requires ${key}`);
  }
  const temporary = await mkdtemp(join(temporaryRoot, "pdmux-notarize-"));
  try {
    const archive = join(temporary, "app.zip");
    // notarytool takes an archive, not a bundle; ditto keeps the code signature intact.
    command("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive], { env, timeout: 600_000 });
    const started = Date.now();
    log(JSON.stringify({ stage: "app-notarization-submit", file: appPath.split("/").pop() }));
    const output = command("xcrun", ["notarytool", "submit", archive, "--key", env.APPLE_API_KEY,
      "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER,
      "--wait", "--timeout", "20m", "--output-format", "json"], { env, timeout: 1_260_000 });
    const receipt = acceptedNotarization(output);
    log(JSON.stringify({ stage: "app-notarization", id: receipt.id, status: receipt.status, seconds: Math.round((Date.now() - started) / 1000) }));
    await stapler("staple", appPath, env);
    await stapler("validate", appPath, env);
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** electron-builder resolves the named export matching the hook name. */
export async function afterSign(context, { notarize = notarizeMacApp, env = process.env } = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await notarize(appPath, env);
}

export default afterSign;
