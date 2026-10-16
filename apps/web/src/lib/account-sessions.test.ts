import { describe, expect, it } from "vitest";
import { listAccountSessions, revokeAccountSession } from "./account-sessions";

describe("account sessions", () => {
  it("asks for one page with the cursor", async () => {
    const paths: string[] = [];
    const client = {
      get: <T>(path: string): Promise<T> => {
        paths.push(path);
        return Promise.resolve({ current: null, items: [], nextCursor: null, total: 0 } as unknown as T);
      },
    };

    await listAccountSessions(client, { limit: 20, cursor: "abc" });
    await listAccountSessions(client, { limit: 20, cursor: null });

    expect(paths).toEqual(["/account/sessions?limit=20&cursor=abc", "/account/sessions?limit=20"]);
  });

  it("revokes by id", async () => {
    const paths: string[] = [];
    const client = {
      del: <T>(path: string): Promise<T> => {
        paths.push(path);
        return Promise.resolve(undefined as unknown as T);
      },
    };

    await revokeAccountSession(client, "id/with slash");

    expect(paths).toEqual(["/account/sessions/id%2Fwith%20slash"]);
  });
});
