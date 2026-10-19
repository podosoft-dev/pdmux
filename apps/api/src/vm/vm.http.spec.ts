import { describe, expect, it } from "bun:test";
import type { Elysia } from "elysia";
import type { AppContext } from "../core/services";
import { ServiceRegistry } from "../core/services";
import { PDMUX, type PdmuxServices } from "../pdmux/pdmux.services";
import { VM_DOCUMENTED_HTTP_ROUTES, VM_HTTP_ROUTES } from "./vm.contract";
import { vmHttpPlugin } from "./vm.http";
import { VM, type VmServices } from "./vm.module-key";

describe("VM routes", () => {
  it("[TC-PDVM-007] serves exactly the routes its contract lists, in the documented form", () => {
    const services = new ServiceRegistry();
    services.register(PDMUX, {} as PdmuxServices);
    services.register(VM, {} as VmServices);
    const routes = ((vmHttpPlugin({ services } as AppContext) as Elysia).routes as { method: string; path: string }[])
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(routes).toEqual([...VM_HTTP_ROUTES].sort());
    expect(VM_DOCUMENTED_HTTP_ROUTES).toContain("PUT /hosts/{hostId}/vm");
  });
});
