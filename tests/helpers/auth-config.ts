import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Waiting for a runtime auth-config change to actually be in effect.
 *
 * WHY: writing `/api/account/auth-config` rebuilds the auth instance. The write
 * returns as soon as the row is stored, so for a short moment afterwards the
 * server can still answer from the previous configuration — and the catalog the
 * settings page reads can be briefly unavailable. A spec that writes a setting
 * and asserts on the very next request is therefore racing a rebuild, which is
 * exactly how this suite produced failures that never reproduced in isolation:
 * the whole run mutates auth config from several specs back to back, and one of
 * them loses the race on any given run.
 *
 * These helpers make the wait explicit. They assert nothing about product
 * behaviour — they only refuse to continue until the server agrees the change
 * landed, so a later failure is a real failure.
 */

/** Poll `/api/account/capabilities` until `predicate` accepts what it reports. */
export async function waitForCapabilities(
  request: APIRequestContext,
  predicate: (capabilities: Record<string, unknown>) => boolean,
  what = "capabilities",
): Promise<void> {
  await expect
    .poll(
      async () => {
        // Cache-bust and defeat revalidation: the endpoint carries an ETag, so a
        // repeated poll can be answered 304 with no body — which would make this
        // helper wait forever for a value it is never shown.
        const response = await request.get(`/api/account/capabilities?_=${Date.now()}`, {
          headers: { "cache-control": "no-cache", "if-none-match": "" },
        });
        if (!response.ok()) return false;
        try {
          return predicate((await response.json()) as Record<string, unknown>);
        } catch {
          return false;
        }
      },
      { message: `timed out waiting for ${what}`, timeout: 15_000, intervals: [100, 200, 400] },
    )
    .toBe(true);
}

/**
 * Write a server-side auth setting and wait until it is observable.
 *
 * Pass the same key you wrote so the wait is about *that* setting rather than a
 * generic "the server answered" check.
 */
export async function setAuthServerConfig(
  request: APIRequestContext,
  patch: Record<string, unknown>,
  observe: { key: string; value: unknown } | null = null,
): Promise<void> {
  const response = await request.put("/api/account/auth-config", { data: { server: patch } });
  expect(response.ok(), `auth-config write failed (${response.status()})`).toBe(true);
  if (!observe) return;
  await waitForCapabilities(
    request,
    (capabilities) => capabilities[observe.key] === observe.value,
    `${observe.key} = ${String(observe.value)}`,
  );
}
