import { ApiError } from "@podosoft/podokit-api-client";
import type { RequestEvent } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackendUnavailableError } from "#lib/server/api.js";
import { handle } from "./hooks.server";

type SessionResult = {
  data: { user: { id: string }; session: { id: string; impersonatedBy?: string | null } } | null;
  error: { status: number } | null;
};

const client = vi.hoisted(() => ({
  get: vi.fn<(path: string) => Promise<unknown>>(),
  getSession: vi.fn<() => Promise<SessionResult>>(),
}));

vi.mock("#lib/server/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/server/api.js")>()),
  serverApiClient: () => ({ get: client.get, auth: { getSession: client.getSession } }),
}));

const resolve = vi.fn(async (): Promise<Response> => new Response("ok"));

function requestEvent(pathname: string, cookies: Record<string, string> = {}): RequestEvent {
  return {
    route: { id: pathname },
    url: new URL(`http://localhost${pathname}`),
    cookies: { get: (name: string) => cookies[name] },
    locals: {},
  } as unknown as RequestEvent;
}

const signedIn: SessionResult = {
  data: { user: { id: "user-1" }, session: { id: "session-1", impersonatedBy: "admin-1" } },
  error: null,
};

describe("handle", () => {
  beforeEach(() => {
    client.get.mockReset();
    client.getSession.mockReset();
    resolve.mockClear();
  });

  it("requests the session without waiting for site settings", async () => {
    let releaseSite: (value: unknown) => void = () => undefined;
    client.get.mockReturnValue(new Promise((settle) => { releaseSite = settle; }));
    client.getSession.mockResolvedValue(signedIn);
    const event = requestEvent("/account");

    const pending = handle({ event, resolve });
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledTimes(1));
    releaseSite({ locale: "ko" });
    await pending;

    expect(client.get).toHaveBeenCalledWith("/site/settings");
    expect(event.locals).toMatchObject({
      site: { locale: "ko" },
      siteUnavailable: false,
      authUnavailable: false,
      locale: "ko",
      user: { id: "user-1" },
      session: { id: "session-1", impersonatedBy: "admin-1" },
    });
  });

  it("treats a site settings client error as a reachable backend", async () => {
    client.get.mockRejectedValue(new ApiError("TWO_FACTOR_REQUIRED", "Two-factor enrolment is required.", 403));
    client.getSession.mockResolvedValue(signedIn);
    const event = requestEvent("/account", { locale: "en" });

    await handle({ event, resolve });

    expect(event.locals).toMatchObject({ site: null, siteUnavailable: false, locale: "en" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("fails closed on protected pages when site settings are unavailable", async () => {
    client.get.mockRejectedValue(new TypeError("fetch failed"));
    client.getSession.mockResolvedValue(signedIn);

    await expect(handle({ event: requestEvent("/account"), resolve })).rejects.toMatchObject({ status: 503 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps public pages available with fallbacks when the backend fails", async () => {
    client.get.mockRejectedValue(new ApiError("UNAVAILABLE", "Unavailable", 503));
    client.getSession.mockRejectedValue(new TypeError("fetch failed"));
    const event = requestEvent("/login");

    await handle({ event, resolve });

    expect(event.locals).toMatchObject({
      site: null,
      siteUnavailable: true,
      authUnavailable: true,
      user: null,
      session: null,
      locale: "en",
    });
  });

  it("treats an API known to be unreachable as an outage", async () => {
    client.get.mockRejectedValue(new BackendUnavailableError());
    client.getSession.mockRejectedValue(new BackendUnavailableError());

    await expect(handle({ event: requestEvent("/account"), resolve })).rejects.toMatchObject({ status: 503 });
    const event = requestEvent("/");
    await handle({ event, resolve });
    expect(event.locals).toMatchObject({ site: null, siteUnavailable: true, authUnavailable: true, user: null });
  });

  it("confirms an anonymous visitor on a 401 session response", async () => {
    client.get.mockResolvedValue({ locale: null });
    client.getSession.mockResolvedValue({ data: null, error: { status: 401 } });
    const event = requestEvent("/");

    await handle({ event, resolve });

    expect(event.locals).toMatchObject({ authUnavailable: false, user: null, session: null });
  });

  it("fails closed on protected pages when the session cannot be checked", async () => {
    client.get.mockResolvedValue({ locale: null });
    client.getSession.mockResolvedValue({ data: null, error: { status: 500 } });

    await expect(handle({ event: requestEvent("/account"), resolve })).rejects.toMatchObject({ status: 503 });
  });

  it("skips runtime lookups for API proxy requests", async () => {
    await handle({ event: requestEvent("/api/site/settings"), resolve });

    expect(client.get).not.toHaveBeenCalled();
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it("answers the health route without runtime lookups", async () => {
    client.get.mockRejectedValue(new BackendUnavailableError());
    client.getSession.mockRejectedValue(new BackendUnavailableError());

    await handle({ event: requestEvent("/healthz"), resolve });

    expect(client.get).not.toHaveBeenCalled();
    expect(client.getSession).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
