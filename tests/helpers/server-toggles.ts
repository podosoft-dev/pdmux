import { expect, type APIRequestContext } from "@playwright/test";

type ServerToggle = "requireEmailVerification" | "requireSignupApproval" | "allowDelete" | "hibp" | "auditLog";

/**
 * Reads the server toggles a test is about to change and returns a function that
 * puts them back. A toggle the database did not store is cleared again, so it
 * follows the environment (for example AUTH_ALLOW_DELETE) as it did before.
 */
export async function serverTogglesRestorer(
  admin: APIRequestContext,
  toggles: readonly ServerToggle[],
): Promise<() => Promise<void>> {
  const response = await admin.get("/api/account/auth-config");
  expect(response.ok(), "read auth-config before changing it").toBeTruthy();
  const view = (await response.json()) as { server: Record<string, unknown>; serverOverrides: string[] };
  const previous = Object.fromEntries(
    toggles.map((toggle) => [toggle, view.serverOverrides.includes(toggle) ? view.server[toggle] : null]),
  );
  return async () => {
    const restored = await admin.put("/api/account/auth-config", { data: { server: previous } });
    expect(restored.ok(), "restore the server toggles").toBeTruthy();
  };
}
