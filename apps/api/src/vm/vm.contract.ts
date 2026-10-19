/** Every route the VM module serves. `vm.http.spec.ts` keeps this list and the plugin equal. */
export const VM_HTTP_ROUTES = [
  "GET /vm/providers",
  "POST /vm/providers",
  "PATCH /vm/providers/:providerId",
  "DELETE /vm/providers/:providerId",
  "POST /vm/providers/:providerId/test",
  "GET /vm/providers/:providerId/catalog",
  "PUT /hosts/:hostId/vm",
  "DELETE /hosts/:hostId/vm",
  "POST /hosts/:hostId/vm/power",
] as const;

/** Forced changes can lose unsaved work in the guest; they stay with fleet administrators. */
export const FORCED_VM_ACTIONS: ReadonlySet<string> = new Set(["stop", "reset"]);

export const VM_POWER_BUDGET = {
  method: "POST",
  pathPrefix: "/hosts/:hostId/vm/power",
  profile: { name: "vm-power", limit: 20, ttlSeconds: 60 },
} as const;

export const VM_DOCUMENTED_HTTP_ROUTES = VM_HTTP_ROUTES.map((route) => route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}"));
