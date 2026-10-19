import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { AppException } from "../common/app-exception";
import { RATE_LIMIT_ROUTES } from "@podosoft/podokit-runtime";
import type { AppContext } from "../core/services";
import { ServiceRegistry } from "../core/services";
import { PDMUX, type PdmuxServices } from "../pdmux/pdmux.services";
import { VM_HTTP_ROUTES, VM_POWER_BUDGET } from "./vm.contract";
import { vmHttpPlugin } from "./vm.http";
import { VM, type VmServices } from "./vm.module-key";

type Session = { user: { id: string; name: string; role: string }; session: { activeOrganizationId: string | null } };

const member: Session = { user: { id: "u-member", name: "Member", role: "user" }, session: { activeOrganizationId: "org-a" } };
const admin: Session = { user: { id: "u-admin", name: "Admin", role: "admin" }, session: { activeOrganizationId: "org-a" } };

function app(session: Session): { handle: (method: string, path: string, body?: unknown) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  const services = new ServiceRegistry();
  services.register(PDMUX, {
    auth: { requireSession: async () => session },
    database: { assertReady: () => undefined },
    audit: { recordRequest: async () => undefined },
  } as unknown as PdmuxServices);
  const view = { name: "vm-500", provider: { id: "p1", kind: "proxmox", name: "lab" }, location: "n1", externalId: "500" };
  services.register(VM, {
    operations: { power: async (scope: string, hostId: string, action: string) => { calls.push(`power ${scope} ${hostId} ${action}`); return view; } },
    machines: {
      link: async () => { calls.push("link"); return view; },
      unlink: async () => { calls.push("unlink"); return { hostId: "h1", name: "vm-500" }; },
    },
    providers: { list: async () => [], create: async () => { calls.push("create"); return { id: "p1", name: "lab", kind: "proxmox", baseUrl: "https://x" }; } },
  } as unknown as VmServices);
  // The app's error envelope, as the pdmux boundary spec mounts it.
  const plugin = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AppException) {
        set.status = error.statusCode;
        return { error: { code: error.code } };
      }
      return undefined;
    })
    .use(vmHttpPlugin({ services } as AppContext));
  return {
    calls,
    handle: (method, path, body) =>
      plugin.handle(new Request(`http://pdmux.test${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })),
  };
}

describe("VM power routes", () => {
  it("[TC-PDVM-015] lets an organization member start, hibernate, shut down and restart, but not force or change the fleet", async () => {
    const { handle, calls } = app(member);
    for (const action of ["start", "hibernate", "shutdown", "reboot"]) {
      expect((await handle("POST", "/hosts/h1/vm/power", { action })).status).toBe(202);
    }
    for (const action of ["stop", "reset"]) {
      const refused = await handle("POST", "/hosts/h1/vm/power", { action });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FLEET_ADMIN_REQUIRED");
    }
    expect((await handle("PUT", "/hosts/h1/vm", { providerId: "p1", node: "n1", vmid: 500 })).status).toBe(403);
    expect((await handle("DELETE", "/hosts/h1/vm")).status).toBe(403);
    expect(calls).toEqual(["power org-a h1 start", "power org-a h1 hibernate", "power org-a h1 shutdown", "power org-a h1 reboot"]);
  });

  it("[TC-PDVM-015] lets a fleet administrator force a power change and link a machine, and rejects an unknown action", async () => {
    const { handle, calls } = app(admin);
    expect((await handle("POST", "/hosts/h1/vm/power", { action: "stop" })).status).toBe(202);
    expect((await handle("POST", "/hosts/h1/vm/power", { action: "reset" })).status).toBe(202);
    expect((await handle("PUT", "/hosts/h1/vm", { providerId: "p1", node: "n1", vmid: 500 })).status).toBe(200);
    expect((await handle("POST", "/hosts/h1/vm/power", { action: "explode" })).status).toBe(400);
    expect(calls).toEqual(["power org-a h1 stop", "power org-a h1 reset", "link"]);
  });

  it("[TC-PDVM-017] gives power changes a budget of their own on the power route", () => {
    const route = VM_HTTP_ROUTES.find((entry) => entry.endsWith(VM_POWER_BUDGET.pathPrefix));
    expect(route).toBe("POST /hosts/:hostId/vm/power");
    expect(VM_POWER_BUDGET.profile).toEqual({ name: "vm-power", limit: 20, ttlSeconds: 60 });
    expect(typeof RATE_LIMIT_ROUTES).toBe("symbol");
  });
});
