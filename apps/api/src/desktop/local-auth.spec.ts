import { expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { desktopLocalAuth } from "./local-auth";
it("[TC-PDDESKTOP-011] refuses local bootstrap on an ordinary web authentication server", async () => {
  const auth = betterAuth({ database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: "http://localhost:5002", secret: "desktop-local-test-01234567890123456789", plugins: [desktopLocalAuth()] });
  const response = await auth.handler(new Request("http://localhost:5002/api/auth/desktop-local/session", {
    method: "POST", headers: { "content-type": "application/json", "x-pdmux-desktop-capability": "a".repeat(43) }, body: "{}",
  }));
  expect(response.status).toBe(404);
});
