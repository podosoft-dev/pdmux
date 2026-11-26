import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { authHandlerRoutes } from "./auth-handler-routes";

type TestApp = { handle: (request: Request) => Promise<Response> };

function appWith(handler: (request: Request) => Promise<Response>): TestApp {
  return new Elysia()
    .onError(({ code, set }) => {
      set.status = code === "NOT_FOUND" ? 404 : 500;
      return { success: false, error: { code } };
    })
    .use(authHandlerRoutes(handler));
}

describe("Better Auth routes", () => {
  test("hands auth and OAuth discovery paths to the handler", async () => {
    const handler = mock(async () => Response.json({ ok: true }));
    const app = appWith(handler);
    for (const path of [
      "/api/auth/get-session",
      "/api/auth/.well-known/openid-configuration",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(200);
    }
    expect(handler).toHaveBeenCalledTimes(4);
  });

  test("leaves other paths to the application's not-found envelope", async () => {
    const handler = mock(async () => new Response(null, { status: 404 }));
    const response = await appWith(handler).handle(new Request("http://localhost/audit-logs"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: { code: "NOT_FOUND" } });
    expect(handler).not.toHaveBeenCalled();
  });

  test("passes the request body through unread", async () => {
    const handler = mock(async (request: Request) => Response.json(await request.json()));
    const response = await appWith(handler).handle(new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    }));
    expect(await response.json()).toEqual({ email: "a@example.com" });
  });
});
