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
] as const;

export const VM_DOCUMENTED_HTTP_ROUTES = VM_HTTP_ROUTES.map((route) => route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}"));
