import { ApiError } from "@podosoft/podokit-api-client";
import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendUnavailableError, serverApiClient } from "./api";
import { backendReachable, checkBackend, reportBackendAnswer } from "./backend-proxy";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function requestEvent(fetch: Fetch): RequestEvent {
  return {
    request: new Request("http://app.localhost/services", { headers: { cookie: "session=abc" } }),
    getClientAddress: () => "203.0.113.9",
    fetch,
  } as unknown as RequestEvent;
}

// Never answers on its own, like a blackholed connection or a hung API, and
// rejects when its signal aborts.
const hang: Fetch = (_input, init) =>
  new Promise((_settle, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
const refuse: Fetch = async () => {
  throw new TypeError("Unable to connect. Is the computer able to access the url?");
};

// The background GET /health check uses the global fetch.
function stubHealth(health: Fetch): ReturnType<typeof vi.fn<Fetch>> {
  const fetch = vi.fn<Fetch>(health);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("serverApiClient", () => {
  afterEach(() => {
    reportBackendAnswer();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the cookie and client address", async () => {
    let headers: Headers | undefined;
    const api = serverApiClient(requestEvent(async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ ok: true });
    }));

    await expect(api.get("/site/settings")).resolves.toEqual({ ok: true });
    expect(headers?.get("cookie")).toBe("session=abc");
    expect(headers?.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  it("gives up on a call that outlasts BACKEND_TIMEOUT_MS", async () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    stubHealth(async () => new Response("ok"));
    const api = serverApiClient(requestEvent(hang));

    const started = Date.now();
    await expect(api.get("/reports/slow")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await checkBackend();
    expect(backendReachable()).toBe(true);
  });

  it("marks the API unreachable when its health check fails as well", async () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "20");
    stubHealth(hang);

    await expect(serverApiClient(requestEvent(hang)).get("/site/settings")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await checkBackend();
    expect(backendReachable()).toBe(false);
  });

  it("fails at once without contacting the API while it is unreachable", async () => {
    stubHealth(refuse);
    await checkBackend();
    const fetch = vi.fn<Fetch>(async () => Response.json({}));

    await expect(serverApiClient(requestEvent(fetch)).get("/blog")).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails calls in flight once the API is found unreachable", async () => {
    stubHealth(refuse);
    const pending = serverApiClient(requestEvent(hang)).get("/site/settings");
    const failed = expect(pending).rejects.toBeInstanceOf(BackendUnavailableError);

    await checkBackend();

    await failed;
  });

  it("treats an error status as an answer from a reachable API", async () => {
    const health = stubHealth(refuse);
    const api = serverApiClient(requestEvent(async () =>
      Response.json({ success: false, error: { code: "INTERNAL", message: "boom", statusCode: 500 } }, { status: 500 })
    ));

    await expect(api.get("/blog")).rejects.toBeInstanceOf(ApiError);
    expect(health).not.toHaveBeenCalled();
    expect(backendReachable()).toBe(true);
  });

  it("does not report a call the caller aborted as an outage", async () => {
    const health = stubHealth(refuse);
    const caller = new AbortController();
    const pending = serverApiClient(requestEvent(hang)).get("/blog", { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(health).not.toHaveBeenCalled();
    expect(backendReachable()).toBe(true);
  });
});
