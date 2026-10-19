import { expect, test } from "../helpers/pdmux-test";
import { expectOnScreen } from "../helpers/geometry";
import { ready } from "../helpers/hydration";
import { NONE, RUNNING, type Fleet, createHost, machine, serveMachine } from "../helpers/vm-fleet";

/**
 * Creating a machine from "Add host", and deleting or re-registering one pdmux created.
 *
 * The VM routes are answered by the test — the e2e stack has no provider, and a create clones a
 * disk. What is measured is the screen's half: the create sends what the form shows (and the same
 * key when it is sent again), deleting needs the exact name, and a machine that never registered
 * offers a retry. The server's half is `vm-lifecycle.service.spec.ts`.
 */

const PROVIDER = {
  id: "00000000-0000-4000-8000-0000000000p1",
  kind: "proxmox",
  name: "lab",
  baseUrl: "https://pve.example.test:8006",
  tokenId: "pdmux@pve!vm-provider",
  caFingerprint: null,
  defaults: { node: "node-1", template: { node: "node-1", vmid: 9001 }, storage: null, pool: "pdmux", vmidMin: 500, vmidMax: 519, cores: 2, memoryMb: 4096, fullClone: false },
  sleepRequiresTag: "on-demand",
  backupBeforeSleep: null,
  enrollUrl: null,
  lastTestedAt: null,
  lastErrorCode: null,
  machineCount: 0,
};

test.describe.serial("pdmux VM create and delete", () => {
  let hostId = "";

  test.beforeAll(async ({ request }) => {
    hostId = await createHost(request, "e2e-vm-created");
  });

  test.afterAll(async ({ request }) => {
    if (hostId) await request.delete(`/api/hosts/${hostId}`);
  });

  test("[TC-PDVM-028] Add host offers a VM from the provider's template, and a resend carries the same key", async ({ page }) => {
    await page.route("**/api/vm/providers", (route) => route.fulfill({ json: [PROVIDER] }));
    await page.route("**/api/vm/providers/*/catalog", (route) => route.fulfill({
      json: { nodes: [{ name: "node-1", online: true }], templates: [{ ref: { node: "node-1", vmid: 9001 }, name: "pdmux-base" }, { ref: { node: "node-1", vmid: 9002 }, name: "big-base" }], storages: [], bridges: [], pools: [] },
    }));
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/vm/machines", async (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      // The first answer is lost on the way back; the person presses Create again.
      if (bodies.length === 1) {
        await route.fulfill({ status: 503, json: { success: false, error: { code: "VM_PROVIDER_UNAVAILABLE", message: "x", statusCode: 503 } } });
        return;
      }
      await route.fulfill({ status: 202, json: { hostId, label: "Build box", vm: { ...machine("unknown", NONE), origin: "created", name: "build-box" } } });
    });

    await ready(page, "/");
    await page.locator("[data-pdmux-add-host]").first().click();
    const dialog = page.getByTestId("host-form");
    await dialog.getByTestId("host-add-vm").click();
    const form = dialog.getByTestId("vm-create");
    await expect(form.getByTestId("vm-create-template")).toHaveText("pdmux-base (provider default)");
    await expect(form.getByTestId("vm-create-cores")).toHaveValue("2");
    await expect(form.getByTestId("vm-create-memory")).toHaveValue("4096");
    await expect(form.getByTestId("vm-create-submit")).toBeDisabled();
    await form.getByTestId("vm-create-label").fill("Build box");
    await form.getByTestId("vm-create-memory").fill("8192");
    await expectOnScreen(form.getByTestId("vm-create-submit"), "create button");

    await form.getByTestId("vm-create-submit").click();
    await expect.poll(() => bodies.length).toBe(1);
    await expect(dialog).toBeVisible();
    await form.getByTestId("vm-create-submit").click();
    await expect(dialog).toBeHidden();

    expect(bodies[0]).toMatchObject({ providerId: PROVIDER.id, label: "Build box", templateNode: null, templateVmid: null, cores: 2, memoryMb: 8192 });
    expect(String(bodies[0]?.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[1]?.idempotencyKey).toBe(bodies[0]?.idempotencyKey);
  });

  test("[TC-PDVM-028] without a provider, Add host is the install path alone", async ({ page }) => {
    await page.route("**/api/vm/providers", (route) => route.fulfill({ json: [] }));
    await ready(page, "/");
    await page.locator("[data-pdmux-add-host]").first().click();
    await expect(page.getByTestId("host-form").getByTestId("host-label")).toBeVisible();
    await expect(page.getByTestId("host-add-mode")).toHaveCount(0);
  });

  test("[TC-PDVM-034] deleting a created machine takes its exact name, then leaves the host page", async ({ page }) => {
    const fleet: Fleet = { hostId, vm: { ...machine("running", { ...RUNNING, delete: true }), origin: "created" }, online: true, requests: [] };
    await serveMachine(page.context(), fleet);
    const sent: unknown[] = [];
    await page.route(`**/api/hosts/${hostId}/vm/delete`, async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: fleet.vm });
    });

    await ready(page, `/hosts/${hostId}`);
    const card = page.getByTestId("host-vm");
    await expect(card.getByTestId("host-vm-unlink")).toHaveCount(0);
    await card.getByTestId("host-vm-delete").click();
    const dialog = page.getByTestId("vm-delete");
    await expect(dialog).toContainText("e2e-vm-500");
    const confirm = dialog.getByTestId("vm-delete-confirm");
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId("vm-delete-name").fill("e2e-vm-50");
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId("vm-delete-name").fill("e2e-vm-500");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => sent).toEqual([{ confirmName: "e2e-vm-500" }]);
    await expect(page).toHaveURL(/\/hosts$/);
  });

  test("[TC-PDVM-030] a created machine that never registered says so and offers a retry", async ({ page }) => {
    const fleet: Fleet = {
      hostId,
      vm: { ...machine("running", { ...RUNNING, delete: true, enroll: true }), origin: "created", error: { code: "VM_ENROLL_TIMEOUT", at: new Date().toISOString() } },
      online: false,
      requests: [],
    };
    await serveMachine(page.context(), fleet);
    let retried = 0;
    await page.route(`**/api/hosts/${hostId}/vm/enroll`, async (route) => {
      retried += 1;
      await route.fulfill({ status: 202, json: fleet.vm });
    });

    await ready(page, `/hosts/${hostId}`);
    const card = page.getByTestId("host-vm");
    await expect(card.getByTestId("host-vm-error")).toContainText("did not register within 15 minutes");
    await card.getByTestId("host-vm-reenroll").click();
    await expect.poll(() => retried).toBe(1);
  });
});
