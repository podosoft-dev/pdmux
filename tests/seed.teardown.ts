import { existsSync, readFileSync } from "node:fs";
import { expect, test as cleanup } from "@playwright/test";
import { ADMIN, userBaselineState } from "./helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

type ListedUser = {
  id: string;
};

cleanup("remove users created by the suite", async ({ playwright }) => {
  if (!existsSync(userBaselineState)) return;
  const baseline = new Set(JSON.parse(readFileSync(userBaselineState, "utf8")) as string[]);
  const ctx = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { origin: base },
  });

  try {
    const signIn = await ctx.post("/api/auth/sign-in/email", {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(signIn.ok(), "sign in before cleaning users").toBeTruthy();

    const users: ListedUser[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const response = await ctx.get(`/api/auth/admin/list-users?limit=${limit}&offset=${offset}`);
      expect(response.ok(), "list users during cleanup").toBeTruthy();
      const body = (await response.json()) as { users?: ListedUser[] };
      const page = body.users ?? [];
      users.push(...page);
      if (page.length < limit) break;
    }

    for (const user of users) {
      if (baseline.has(user.id)) continue;
      const response = await ctx.post("/api/auth/admin/remove-user", {
        data: { userId: user.id },
      });
      expect(response.ok(), `remove disposable user ${user.id}`).toBeTruthy();
    }
  } finally {
    await ctx.dispose();
  }
});
