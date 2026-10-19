import { expect, test } from "../helpers/pdmux-test";
import { expectOnScreen } from "../helpers/geometry";
import { ready } from "../helpers/hydration";

/**
 * The fleet's VM providers, from the settings screen.
 *
 * The provider routes are answered by the test: a real connection is tested by the server before
 * it is stored, and the e2e stack has no provider to reach. What is measured here is the screen's
 * half — that it refuses an incomplete form before sending, sends the secret only when one was
 * typed, never shows the stored secret back, and will not remove a provider machines still use.
 */

type Provider = Record<string, unknown> & { id: string; name: string; machineCount: number };

function provider(name: string, machineCount: number): Provider {
  return {
    id: `00000000-0000-4000-8000-${name.replace(/\W/g, "").padStart(12, "0").slice(-12)}`,
    kind: "proxmox",
    name,
    baseUrl: "https://pve.example.test:8006",
    tokenId: "pdmux@pve!vm-provider",
    caFingerprint: "AB:CD:EF",
    defaults: { node: "node-1", template: null, storage: null, pool: null, vmidMin: 500, vmidMax: 519, cores: 2, memoryMb: 4096, diskGb: 64, fullClone: false },
    sleepRequiresTag: "on-demand",
    backupBeforeSleep: null,
    enrollUrl: null,
    lastTestedAt: "2026-10-19T08:00:00.000Z",
    lastErrorCode: null,
    machineCount,
  };
}

test("[TC-PDVM-027] settings list the fleet's providers, add one, keep the secret write-only and refuse removing one in use", async ({ page }) => {
  const rows: Provider[] = [provider("lab", 1)];
  const sent: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  await page.route("**/api/vm/providers**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const body = request.postData() ? (JSON.parse(request.postData() ?? "{}") as Record<string, unknown>) : null;
    if (request.method() === "GET") return route.fulfill({ json: rows });
    sent.push({ method: request.method(), path, body });
    if (request.method() === "POST" && path === "/vm/providers") {
      const created = provider(String(body?.name), 0);
      rows.push(created);
      return route.fulfill({ json: created });
    }
    if (request.method() === "PATCH") return route.fulfill({ json: rows[0] });
    if (path.endsWith("/test")) {
      const tested = { ...rows[0], lastErrorCode: "VM_PROVIDER_AUTH_FAILED" } as Provider;
      rows[0] = tested;
      return route.fulfill({ json: tested });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await ready(page, "/settings?tab=integrations");
  const card = page.getByTestId("vm-providers");
  await expect(card.getByTestId("vm-provider-row")).toHaveCount(1, { timeout: 15_000 });
  // In use by a machine: removing is not offered.
  await expect(card.getByTestId("vm-provider-remove")).toBeDisabled();

  // A failed test is shown on the row, in words.
  await card.getByTestId("vm-provider-test").click();
  await expect(card.getByTestId("vm-provider-status")).toHaveClass(/text-destructive/);

  // Editing: the secret field is empty and stays out of the request when left so.
  await card.getByTestId("vm-provider-edit").click();
  const form = page.getByTestId("vm-provider-form");
  await expect(form.getByTestId("vm-p-token-secret")).toHaveValue("");
  await form.getByTestId("vm-p-optional-toggle").click();
  await expect(form.getByTestId("vm-p-ca")).toHaveValue("");
  await form.getByTestId("vm-p-advanced-toggle").click();
  await form.getByTestId("vm-p-sleep-tag").fill("pdmux");
  await form.getByTestId("vm-p-save").click();
  await expect(form).toBeHidden();
  const edit = sent.find((entry) => entry.method === "PATCH");
  expect(edit?.body).toMatchObject({ sleepRequiresTag: "pdmux" });
  expect(edit?.body).not.toHaveProperty("tokenSecret");
  expect(edit?.body).not.toHaveProperty("caCertificate");

  // Adding: incomplete is refused before sending; a token id without "!" is not a token id.
  await card.getByTestId("vm-provider-add").click();
  await expect(form.getByTestId("vm-p-save")).toBeDisabled();
  await form.getByTestId("vm-p-optional-toggle").click();
  await form.getByTestId("vm-p-name").fill("second");
  await form.getByTestId("vm-p-url").fill("https://pve2.example.test:8006");
  await form.getByTestId("vm-p-token-id").fill("pdmux@pve");
  await form.getByTestId("vm-p-token-secret").fill("not-a-real-secret");
  await expect(form.getByTestId("vm-p-save")).toBeDisabled();
  await form.getByTestId("vm-p-token-id").fill("pdmux@pve!vm-provider");
  await expectOnScreen(form.getByTestId("vm-p-save"), "save button");
  await form.getByTestId("vm-p-save").click();
  await expect(card.getByTestId("vm-provider-row")).toHaveCount(2);
  const create = sent.find((entry) => entry.method === "POST" && entry.path === "/vm/providers");
  expect(create?.body).toMatchObject({ kind: "proxmox", name: "second", vmidMin: 500, vmidMax: 599 });
  // The secret is never shown back: the new row carries none.
  await expect(card).not.toContainText("not-a-real-secret");
  // Not in use: removable.
  await expect(card.locator("[data-provider=second]").getByTestId("vm-provider-remove")).toBeEnabled();
});

test("[TC-PDVM-027] on a phone the provider form fits the screen: no field runs past the dialog, Save stays in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A long CA fingerprint is one unbroken word; it must wrap rather than widen the form.
  const long = { ...provider("lab", 1), caFingerprint: Array.from({ length: 32 }, () => "3A").join(":") };
  await page.route("**/api/vm/providers", (route) => route.fulfill({ json: [long] }));
  await ready(page, "/settings?tab=integrations");
  await page.getByTestId("vm-provider-edit").click();
  const form = page.getByTestId("vm-provider-form");
  await expect(form).toBeVisible();
  const dialog = await form.boundingBox();
  expect(dialog).toBeTruthy();
  if (!dialog) return;
  for (const box of await form.locator("input, textarea").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width + 1);
  }
  await expectOnScreen(form.getByTestId("vm-p-save"), "save button");
});

test("[TC-PDVM-040] a new provider asks for its platform, address and credentials; the rest is the platform's defaults, folded", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/vm/providers", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return route.fulfill({ status: 201, json: { ...provider("pve.example.test", 0), name: "pve.example.test" } });
  });
  await ready(page, "/settings?tab=integrations");
  await page.getByTestId("vm-provider-add").click();
  const form = page.getByTestId("vm-provider-form");

  // The platform is a visible choice; the ones without a driver yet say so and cannot be picked.
  await expect(form.getByTestId("vm-p-platform-proxmox")).toHaveAttribute("data-state", "on");
  await expect(form.getByTestId("vm-p-platform-aws")).toBeDisabled();
  await expect(form.getByTestId("vm-p-platform-azure")).toContainText("Coming later");

  // The platform's defaults, from the server, in one line; the fields themselves are folded away.
  await expect(form.getByTestId("vm-p-defaults-summary")).toHaveText("4 vCPU · 16 GB memory · 64 GB disk · ids 500–599");
  await expect(form.getByTestId("vm-p-cores")).toBeHidden();
  await expect(form.getByTestId("vm-p-sleep-tag")).toBeHidden();
  // So is everything else that is optional: the name, the CA and the permission table.
  await expect(form.getByTestId("vm-p-name")).toBeHidden();
  await expect(form.getByTestId("vm-p-ca")).toBeHidden();
  await expect(form.locator("[data-testid=vm-p-perm] dl")).toBeHidden();

  // Address and credentials are enough; the name follows the address.
  await expect(form.getByTestId("vm-p-save")).toBeDisabled();
  await form.getByTestId("vm-p-url").fill("https://pve.example.test:8006");
  // The folded options say what they hold without being opened.
  await expect(form.getByTestId("vm-p-optional-summary")).toHaveText("Name: pve.example.test · CA: the system's trusted CAs");
  await form.getByTestId("vm-p-token-id").fill("pdmux@pve!vm-provider");
  await form.getByTestId("vm-p-token-secret").fill("not-a-real-secret");
  await expect(form.getByTestId("vm-p-save")).toBeEnabled();

  // Opening the defaults shows them as values that can be changed.
  await form.getByTestId("vm-p-defaults-toggle").click();
  await expect(form.getByTestId("vm-p-cores")).toHaveValue("4");
  await expect(form.getByTestId("vm-p-memory")).toHaveValue("16");
  await expect(form.getByTestId("vm-p-disk")).toHaveValue("64");

  // The permissions a token needs, as a table rather than one sentence.
  await form.getByTestId("vm-p-perm-toggle").click();
  await expect(form.locator("[data-testid=vm-p-perm] dt")).toHaveText(["Pool for new machines", "Template", "VM disk and backup storage", "Network (the bridge's SDN zone)", "Machines you only link"]);

  // What a setting means is one hover — or tap — away, on the setting itself.
  await form.getByTestId("vm-p-full-clone-tip").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toContainText("linked clone");
  await form.getByTestId("vm-p-advanced-toggle").click();
  for (const id of ["node", "storage", "pool", "sleep-tag", "backup", "enroll-url"]) {
    await expect(form.getByTestId(`vm-p-${id}-tip`)).toHaveAttribute("aria-label", /.{30,}/);
  }

  await form.getByTestId("vm-p-save").click();
  await expect(form).toBeHidden();
  expect(sent[0]).toMatchObject({
    kind: "proxmox",
    name: "",
    defaultCores: 4,
    defaultMemoryMb: 16_384,
    defaultDiskGb: 64,
    vmidMin: 500,
    vmidMax: 599,
    defaultTemplateNode: null,
    defaultPool: null,
  });
});
