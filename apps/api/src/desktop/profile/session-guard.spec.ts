import { expect, it } from "bun:test";
import { AuthService } from "../../auth/auth.service";
import { AccessPolicy } from "../../core/services";
import type { SettingsService } from "../../settings/settings.service";
import { requireDesktopSession } from "./session-guard";

it("[TC-PDDESKTOP-015] ignores legacy web enrolment policy locally while retaining the web guard", async () => {
  const policy = new AccessPolicy();
  const settings = { getBool: async () => true } as unknown as SettingsService;
  const auth = new AuthService(settings, policy, { resolveSession: async () => ({ user: { id:"local-profile", twoFactorEnabled:false }, session:{} }) });
  const request = new Request("http://localhost/hosts");
  await expect(auth.guard(request)).rejects.toMatchObject({ code:"TWO_FACTOR_REQUIRED" });
  await expect(requireDesktopSession(auth, policy, request)).resolves.toBeUndefined();
});
it("[TC-PDDESKTOP-015] requires a real local session and leaves public capability routes public", async () => {
  const policy = new AccessPolicy();
  const auth = { requireSession: async (): Promise<never> => { throw new Error("AUTH_REQUIRED"); } };
  await expect(requireDesktopSession(auth,policy,new Request("http://localhost/hosts"))).rejects.toThrow("AUTH_REQUIRED");
  policy.register("GET","/public","public");
  await expect(requireDesktopSession(auth,policy,new Request("http://localhost/public"))).resolves.toBeUndefined();
});
