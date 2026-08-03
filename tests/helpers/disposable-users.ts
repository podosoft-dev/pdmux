import {
  expect,
  test as base,
  type APIResponse,
} from "@playwright/test";

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
  disposableUsers: async ({ context }, use) => {
    // Reuse the browser context's storageState-backed request client. Creating
    // a second admin login here can revoke the browser session in applications
    // that enforce a single concurrent session.
    const request = context.request;
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
      for (const userId of userIds) {
        const response = await request.post("/api/auth/admin/remove-user", {
          headers: origin,
          data: { userId },
        });
        if (!response.ok() && response.status() !== 404) {
          throw new Error(`Failed to remove disposable user ${userId}: HTTP ${response.status()}`);
        }
      }
    }
  },
});

export { expect };
