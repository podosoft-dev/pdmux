import type { Capabilities } from "@podosoft/podokit-api-client";
import { describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_CAPABILITIES, getCapabilities } from "./capabilities";
import { loadProtectedLayout } from "./protected-layout";

type TestUser = NonNullable<App.Locals["user"]>;
type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

function fetchMock(respond: () => Promise<Response>): FetchMock {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(respond);
}

function locals(user: TestUser | null = null): App.Locals {
  return {
    user,
    session: user ? { id: "session-1", impersonatedBy: null } : null,
    authUnavailable: false,
    locale: "en",
    site: null,
    siteUnavailable: false,
  };
}

function capabilitiesFetch(capabilities: Partial<Capabilities>): FetchMock {
  return fetchMock(async () => Response.json({ ...DEFAULT_CAPABILITIES, twoFactor: true, ...capabilities }));
}

const member: TestUser = { id: "user-1", email: "user@example.com", name: "User", twoFactorEnabled: false };

describe("getCapabilities", () => {
  it("fetches once for every load in the same request", async () => {
    const fetch = capabilitiesFetch({ auditLog: true });
    const request = locals(member);

    const [first, second] = await Promise.all([
      getCapabilities({ locals: request, fetch }),
      getCapabilities({ locals: request, fetch }),
    ]);
    const third = await getCapabilities({ locals: request, fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/account/capabilities");
    expect(first.auditLog).toBe(true);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("fetches again for a new request", async () => {
    const fetch = capabilitiesFetch({});

    await getCapabilities({ locals: locals(member), fetch });
    await getCapabilities({ locals: locals(member), fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resolves to safe defaults when the endpoint fails", async () => {
    const rejected = fetchMock(async () => {
      throw new TypeError("fetch failed");
    });
    const unavailable = fetchMock(async () => new Response("", { status: 503 }));

    await expect(getCapabilities({ locals: locals(), fetch: rejected })).resolves.toEqual(DEFAULT_CAPABILITIES);
    await expect(getCapabilities({ locals: locals(), fetch: unavailable })).resolves.toEqual(DEFAULT_CAPABILITIES);
  });
});

describe("loadProtectedLayout", () => {
  it("sends an un-enrolled user to setup when the policy requires two-factor", async () => {
    const fetch = capabilitiesFetch({ require2fa: true });

    await expect(loadProtectedLayout({ locals: locals(member), fetch })).rejects.toMatchObject({
      status: 302,
      location: "/setup-2fa",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith("/api/account/require-2fa");
  });

  it("lets enrolled users through and shares the capabilities response", async () => {
    const fetch = capabilitiesFetch({ require2fa: true });
    const request = locals({ ...member, twoFactorEnabled: true });

    const data = await loadProtectedLayout({ locals: request, fetch });

    expect(data.capabilities.require2fa).toBe(true);
    expect(data.capabilities).toBe(await getCapabilities({ locals: request, fetch }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed before fetching when the backend could not be checked", async () => {
    const fetch = capabilitiesFetch({});
    const request = { ...locals(member), authUnavailable: true };

    await expect(loadProtectedLayout({ locals: request, fetch })).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
