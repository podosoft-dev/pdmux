import {
  expect,
  test as base,
  type APIResponse,
} from "@playwright/test";
import { ADMIN } from "./accounts";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: baseURL };

type CreateUserInput = {
  email: string;
  password?: string;
  name?: string;
  role?: string;
};

export type DisposableUsers = {
  create(input: CreateUserInput): Promise<string>;
  trackResponse(response: APIResponse): Promise<string>;
  track(userId: string): void;
  forget(userId: string): void;
};

async function readCreatedUserId(response: APIResponse): Promise<string> {
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { user?: { id?: unknown } };
  expect(typeof body.user?.id).toBe("string");
  return body.user?.id as string;
}

export const test = base.extend<{ disposableUsers: DisposableUsers }>({
  disposableUsers: async ({ context, playwright }, use, testInfo) => {
    // API projects do not inherit the UI project's admin storageState, while a
    // second admin sign-in can invalidate the shared UI session. Authenticate an
    // isolated request context only for API tests and reuse browser cookies for UI.
    let request = context.request;
    let ownsRequest = false;
    if (testInfo.project.name === "api") {
      request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: origin,
      });
      ownsRequest = true;
      const signIn = await request.post("/api/auth/sign-in/email", {
        data: { email: ADMIN.email, password: ADMIN.password },
      });
      expect(signIn.ok(), "sign in disposable user fixture").toBeTruthy();
    }
    const userIds = new Set<string>();

    const disposableUsers: DisposableUsers = {
      async create(input): Promise<string> {
        const response = await request.post("/api/auth/admin/create-user", {
          headers: origin,
          data: {
            password: "Podokit3e-Str0ng!pw",
            name: "Throwaway",
            role: "user",
            ...input,
          },
        });
        const userId = await readCreatedUserId(response);
        userIds.add(userId);
        return userId;
      },
      async trackResponse(response): Promise<string> {
        const userId = await readCreatedUserId(response);
        userIds.add(userId);
        return userId;
      },
      track(userId): void {
        userIds.add(userId);
      },
      forget(userId): void {
        userIds.delete(userId);
      },
    };

    try {
      await use(disposableUsers);
    } finally {
      try {
        for (const userId of userIds) {
          const response = await request.post("/api/auth/admin/remove-user", {
            headers: origin,
            data: { userId },
          });
          if (!response.ok() && response.status() !== 404) {
            throw new Error(`Failed to remove disposable user ${userId}: HTTP ${response.status()}`);
          }
        }
      } finally {
        if (ownsRequest) await request.dispose();
      }
    }
  },
});

export { expect };
