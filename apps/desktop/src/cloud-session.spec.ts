import { expect, it } from "bun:test";
import { connectFailure, reconnectDelayMs, withoutStoredExpiry, type SessionCipher } from "./cloud-session.js";

// A reversible stand-in for safeStorage: the code under test must not care what the cipher is.
const cipher: SessionCipher = {
  encrypt: value => Buffer.from(`enc:${value}`),
  decrypt: value => { const text = value.toString(); if (!text.startsWith("enc:")) throw new Error("not ours"); return text.slice(4); },
};
const stored = (jar: unknown): string => cipher.encrypt(JSON.stringify(jar)).toString("base64");
const read = (item: unknown): unknown => JSON.parse(cipher.decrypt(Buffer.from(String(item), "base64")));

it("[TC-PDDESKTOP-029] the stored session cookie is read without the expiry it was signed in with", () => {
  // The shape `@better-auth/electron` stores: the expiry of the sign-in Set-Cookie, never renewed on
  // this side although the server extends the session on every use (2026-10-26).
  const jar = {
    "__Secure-better-auth.session_token": { value: "token.sig", expires: "2026-10-26T04:35:54.000Z" },
    "__Secure-better-auth.session_data": { value: "cache", expires: "2026-10-19T04:40:54.000Z" },
  };
  expect(read(withoutStoredExpiry(stored(jar), cipher))).toEqual({
    "__Secure-better-auth.session_token": { value: "token.sig", expires: null },
    "__Secure-better-auth.session_data": { value: "cache", expires: null },
  });
  // Nothing to read, or something that is not ours: returned untouched, so it fails as before.
  expect(withoutStoredExpiry(undefined, cipher)).toBeUndefined();
  expect(withoutStoredExpiry("", cipher)).toBe("");
  const foreign = Buffer.from("plain").toString("base64");
  expect(withoutStoredExpiry(foreign, cipher)).toBe(foreign);
  const list = stored(["not", "a", "jar"]);
  expect(withoutStoredExpiry(list, cipher)).toBe(list);
});

it("[TC-PDDESKTOP-030] a failed launch connection is retried with backoff unless the server ended the session", () => {
  expect(connectFailure(Object.assign(new Error("Desktop connection failed (401)"), { status: 401 }))).toBe("signed-out");
  for (const error of [Object.assign(new Error("x"), { status: 409 }), Object.assign(new Error("x"), { status: 503 }), new TypeError("fetch failed"), null]) {
    expect(connectFailure(error)).toBe("transient");
  }
  expect([0, 1, 2, 3].map(reconnectDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
  expect(reconnectDelayMs(20)).toBe(300_000);
  expect(reconnectDelayMs(-1)).toBe(5_000);
});
