import { describe, expect, it } from "bun:test";
import type { Repository } from "typeorm";
import type { AuthSession } from "../auth/auth.service";
import type { PdmuxServices } from "../pdmux/pdmux.services";
import { DesktopRouter } from "./desktop-router";
import type { DesktopRecord } from "./desktop-record.entity";
import { DesktopService } from "./desktop.service";

const HOST = "6f1c1f9e-8f7a-4e8c-9a51-1d2f3b4c5d6e";
const session = (user: string, org: string): AuthSession => ({ user: { id: user }, session: { activeOrganizationId: org } }) as unknown as AuthSession;

function fixture(hosts: { list: () => Promise<never[]> } = { list: async () => [] }): { router: DesktopRouter; service: DesktopService } {
  const pdmux = {
    auth: { requireSession: async (request: Request) => session(request.headers.get("x-user")!, request.headers.get("x-org")!) },
    hosts,
  } as unknown as PdmuxServices;
  const records = { find: async () => [], exist: async () => false } as unknown as Repository<DesktopRecord>;
  const service = new DesktopService(pdmux, records);
  return { router: new DesktopRouter(service, null), service };
}
function write(method: string, path: string, user: string, org: string): Request {
  return new Request(`http://api.test${path}`, { method, headers: { "x-user": user, "x-org": org } });
}
/** Whether a promise has settled once every queued callback has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  return done;
}

describe("[TC-PDDESKTOP-015] metadata writes lock only what they change", () => {
  it("[TC-PDDESKTOP-013] removes a mirrored host on the server without contacting its offline desktop", async () => {
    const pdmux = { auth: { requireSession: async () => session("owner", "") }, hosts: { get: async () => ({ id: HOST }) } } as unknown as PdmuxServices;
    const record = { kind: "host", hostId: HOST, origin: "offline-desktop", value: { label: "Offline desktop" }, connectionKey: "" };
    const records = { find: async () => [record] } as unknown as Repository<DesktopRecord>;
    const service = new DesktopService(pdmux, records), router = new DesktopRouter(service, null);
    const request = write("DELETE", `/hosts/${HOST}`, "owner", "");
    try {
      expect(await router.forward(request)).toBeUndefined();
      expect(service.lock.size).toBe(1);
    } finally { router.release(request); }
    expect(service.lock.size).toBe(0);
  });
  it("[TC-PDDESKTOP-015] a slow layout save delays the same user's next write, not another user's", async () => {
    const { router, service } = fixture();
    const slowA = write("PUT", "/prefs/layouts/main", "user-a", "org-1");
    await router.forward(slowA);
    const others = [write("PUT", "/prefs/layouts/main", "user-b", "org-1"), write("PUT", `/prefs/hosts/${HOST}`, "user-c", "org-2")];
    for (const request of others) expect(await settled(router.forward(request))).toBe(true);
    const nextA = write("DELETE", "/prefs/layouts/old", "user-a", "org-2");
    const waiting = router.forward(nextA);
    expect(await settled(waiting)).toBe(false);
    router.release(slowA);
    await waiting;
    for (const request of [nextA, ...others]) router.release(request);
    expect(service.lock.size).toBe(0);
  });

  it("[TC-PDDESKTOP-015] a sync holds the scope's host writes and the user's preference writes only", async () => {
    const { router, service } = fixture();
    const sync = await service.lock.acquire(service.syncKeys(session("user-a", "org-1")));
    const waiting = [write("PATCH", `/hosts/${HOST}`, "user-b", "org-1"), write("PUT", "/prefs/layouts/main", "user-a", "org-2"), write("POST", "/hosts", "user-c", "org-1")];
    const blocked = waiting.map(request => router.forward(request));
    for (const pending of blocked) expect(await settled(pending)).toBe(false);
    const free = [write("DELETE", `/hosts/${HOST}`, "user-b", "org-2"), write("PUT", "/prefs/layouts/main", "user-b", "org-1")];
    for (const request of free) expect(await settled(router.forward(request))).toBe(true);
    sync();
    // Arrival order at the lock is not request order, so release each write once it holds the lock.
    await Promise.all(waiting.map(async (request, index) => { await blocked[index]; router.release(request); }));
    for (const request of free) router.release(request);
    expect(service.lock.size).toBe(0);
  });

  it("[TC-PDDESKTOP-015] releases the lock when a write or a sync fails", async () => {
    const { router, service } = fixture({ list: async () => { throw new Error("database unavailable"); } });
    const failed = write("PUT", "/prefs/layouts/main", "user-a", "org-1");
    await router.forward(failed);
    router.release(failed);
    router.release(failed);
    expect(service.lock.size).toBe(0);
    const batch = { version: 1, deviceId: crypto.randomUUID(), name: "test", changes: [] };
    await expect(service.sync(session("user-a", "org-1"), batch)).rejects.toThrow("database unavailable");
    expect(service.lock.size).toBe(0);
    const next = write("PATCH", `/hosts/${HOST}`, "user-a", "org-1");
    expect(await settled(router.forward(next))).toBe(true);
    router.release(next);
    expect(service.lock.size).toBe(0);
  });
});
