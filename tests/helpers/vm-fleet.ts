/**
 * A host whose machine the test owns, for the VM power specs.
 *
 * A real host row (created and deleted by the spec) carries a `vm` block served from one
 * in-test state, so every browser context the spec opens reads the same machine — the way the
 * server's row is one truth for every screen. The power route is answered from that state too.
 */
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";

export type Vm = Record<string, unknown> & { state: string; operation: unknown; available: Record<string, boolean> };

export const NONE = { start: false, hibernate: false, shutdown: false, stop: false, reboot: false, reset: false, delete: false };
export const RUNNING = { ...NONE, hibernate: true, shutdown: true, reboot: true, stop: true, reset: true };
export const ASLEEP = { ...NONE, start: true };

export function machine(state: string, available: Record<string, boolean>, operation: unknown = null): Vm {
  return {
    provider: { id: "00000000-0000-4000-8000-0000000000p1", kind: "proxmox", name: "lab" },
    origin: "linked",
    name: "e2e-vm-500",
    location: "node-1",
    externalId: "500",
    state,
    observedAt: new Date().toISOString(),
    operation,
    error: null,
    available,
  };
}

export interface Fleet {
  hostId: string;
  vm: Vm;
  online: boolean;
  requests: string[];
}

/** Serve the shared machine state to a context, and answer its power requests the way the server would. */
export async function serveMachine(context: BrowserContext, fleet: Fleet): Promise<void> {
  await context.route("**/api/hosts", async (route) => {
    const response = await route.fetch();
    const hosts = (await response.json()) as Record<string, unknown>[];
    await route.fulfill({
      response,
      json: hosts.map((host) => host.id === fleet.hostId ? { ...host, online: fleet.online, connected: fleet.online, vm: fleet.vm } : host),
    });
  });
  await context.route(`**/api/hosts/${fleet.hostId}/vm/power`, async (route) => {
    const { action } = route.request().postDataJSON() as { action: string };
    fleet.requests.push(action);
    if (fleet.vm.operation) {
      await route.fulfill({
        status: 409,
        json: { success: false, error: { code: "VM_OPERATION_IN_PROGRESS", message: "busy", statusCode: 409, details: { action: "hibernate", requestedBy: "Alice" } } },
      });
      return;
    }
    fleet.vm = machine(fleet.vm.state, NONE, { action, step: "request", startedAt: new Date().toISOString(), requestedBy: { id: "u-alice", name: "Alice" } });
    await route.fulfill({ status: 202, json: fleet.vm });
  });
}

export interface SavedLayout {
  name: string;
  payload: Record<string, unknown>;
  isDefault: boolean;
}

/**
 * The account's saved layout, so the spec can put it back.
 *
 * ⚠ THE WORKER ACCOUNT IS SHARED BY EVERY SPEC IN THE RUN. Leaving it in one-pane `tab` mode made
 * the next file's "two panes" test fail for a reason that had nothing to do with it (measured
 * 2026-10-19 with `[TC-PDUI-142]`).
 */
export async function captureLayout(request: APIRequestContext): Promise<SavedLayout | null> {
  const response = await request.get("/api/prefs");
  if (!response.ok()) return null;
  const prefs = (await response.json()) as { layouts?: SavedLayout[] };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
  return layout ? { name: layout.name, payload: layout.payload, isDefault: layout.isDefault ?? true } : null;
}

export async function restoreLayout(request: APIRequestContext, saved: SavedLayout | null): Promise<void> {
  if (!saved) {
    await request.delete("/api/prefs/layouts/default");
    return;
  }
  const response = await request.put(`/api/prefs/layouts/${encodeURIComponent(saved.name)}`, {
    data: { payload: saved.payload, isDefault: saved.isDefault },
  });
  expect(response.ok(), "restore the layout captured before the spec").toBeTruthy();
}

/** Point the account's grid at `panes` panes on the host (`tab` mode for one). */
export async function layoutOn(request: APIRequestContext, saved: SavedLayout | null, hostId: string, panes: number): Promise<void> {
  const slots = Array.from({ length: panes }, (_, index) => ({ id: `vm-pane-${index}`, hostId, kind: "attach", session: "e2e-vm" }));
  const payload = { ...(saved?.payload ?? {}), mode: panes > 1 ? "split2" : "tab", page: 0, slots, zoomId: null, focusId: null };
  await request.put(`/api/prefs/layouts/${encodeURIComponent(saved?.name ?? "default")}`, { data: { payload, isDefault: true } });
}

/** A real host row for the spec; returns its id. */
export async function createHost(request: APIRequestContext, prefix: string): Promise<string> {
  const created = await request.post("/api/hosts", { data: { label: `${prefix}-${Date.now().toString().slice(-6)}` } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = (await created.json()) as { host?: { id: string }; id?: string };
  return body.host?.id ?? body.id ?? "";
}
