import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";
import { e2eAdminState } from "../helpers/accounts";

/**
 * Connecting a coding CLI to a host.
 *
 * The assertion that matters most is a NEGATIVE one: the two blocks this screen
 * exists to be copied from must not contain the key. A config block is the single
 * most likely thing here to end up committed to a repository, and a secret that
 * travels in it leaks by construction.
 */
test.use({ storageState: e2eAdminState });

/** Any real key starts like this; a fixture must never match it by accident. */
const KEY_SHAPE = /pdmux_mcp_[A-Za-z0-9_-]{20}/;

/**
 * Open the connection card, because it is a disclosure and it ships CLOSED.
 *
 * ⚠ THESE TESTS USED TO SKIP THIS, AND TWO OF THEM PASSED ANYWAY. `toHaveText` and
 * `toContainText` read `textContent` and do not require visibility, so the copy
 * assertions were being made against a section nobody could see — they were green
 * while measuring markup rather than a screen. Only the `toBeVisible()` in
 * TC-PDMCP-100 and the first `click()` in TC-PDMCP-102 ever noticed.
 *
 * The card is closed by default on purpose (its own comment says so, and the "N
 * keys" summary beside the title is what makes that honest), so opening it is what
 * a person does — and doing it here is what makes the rest of the file measure what
 * they would actually be looking at.
 */
async function openConnection(page: import("@playwright/test").Page): Promise<void> {
  const section = page.locator("[data-testid='agent-access']");
  if (await section.isVisible()) return;
  await page.locator("[data-testid='host-connection-toggle']").click();
  await expect(section).toBeVisible();
}

test.describe.serial("pdmux agent connection", () => {
  /**
   * A REAL host, because the detail page's loader runs on the SERVER and
   * `page.route` cannot see it. The shell's feed — which the browser fetches, and
   * which this component actually reads — is mocked on top, exactly as the page
   * documents: the loader is the first paint, the feed is every one after it.
   */
  let hostId = "";
  const label = `e2e-mcp-${Date.now().toString().slice(-6)}`;

  test.beforeAll(async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    const made = await api.post("/api/hosts", { data: { label, tags: [] } });
    hostId = (await made.json()).id as string;
    await api.dispose();
  });

  test.afterAll(async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    await api.delete(`/api/hosts/${hostId}`);
    await api.dispose();
  });

  const feedRow = () => ({
    id: hostId,
    label,
    address: null,
    agentAddress: null,
    description: null,
    tags: [],
    sortOrder: 0,
    enabled: true,
    agentVersion: "0.1.3",
    latestAgentVersion: "0.1.3",
    agentVersionState: "current",
    lastUpdate: null,
    os: "darwin",
    arch: "arm64",
    capabilities: ["metrics", "exec"],
    lastSeenAt: new Date().toISOString(),
    online: true,
    connected: true,
    resource: null,
    sessions: [],
    // The host reports Claude, so the client tab must open on Claude.
    usage: [{ provider: "claude", processes: 1, ts: null, windows: [] }],
    services: [],
  });

  test("[TC-PDMCP-100] offers a config for the CLI the host reports, and never a secret", async ({ page }) => {
    await page.route("**/api/hosts", (route) => route.fulfill({ json: [feedRow()] }));
        await page.route(`**/api/hosts/${hostId}/services`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/hosts/${hostId}/tokens`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/hosts/${hostId}/mcp-keys`, (route) => route.fulfill({ json: [] }));

    await ready(page, `/hosts/${hostId}`);
    await openConnection(page);

    // The endpoint is the URL a person pastes; it has to be the public origin.
    await expect(page.locator("[data-testid='agent-endpoint']")).toContainText("/mcp");

    // Defaulted from the host's own usage report, not from the browser or a guess.
    await expect(page.locator("[data-testid='agent-client'] [data-state='active']")).toHaveText("Claude Code");
    const config = page.locator("[data-testid='agent-client-config']");
    await expect(config).toContainText("mcpServers");
    await expect(config).toContainText("PDMUX_MCP_KEY");
    await expect(config).not.toHaveText(KEY_SHAPE);

    // Switching client changes the shape, and neither shape carries a secret.
    await page.locator("[data-testid='agent-client-codex']").click();
    await expect(config).toContainText("codex mcp add pdmux");
    await expect(config).toContainText("--bearer-token-env-var PDMUX_MCP_KEY");
    await expect(config).not.toHaveText(KEY_SHAPE);

    // The handoff is the other copyable block, and it is the one a person is most
    // likely to paste into a chat window.
    const handoff = page.locator("[data-testid='agent-handoff']");
    await expect(handoff).toContainText(label);
    await expect(handoff).toContainText("PDMUX_MCP_KEY");
    await expect(handoff).toContainText("host_install_command");
    await expect(handoff).not.toHaveText(KEY_SHAPE);
  });

  test("[TC-PDMCP-102] opens on the OS the host reported, and names that shell's file", async ({ page }) => {
    await page.route("**/api/hosts", (route) => route.fulfill({ json: [feedRow()] }));
    await page.route(`**/api/hosts/${hostId}/services`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/hosts/${hostId}/tokens`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/hosts/${hostId}/mcp-keys`, (route) => route.fulfill({ json: [] }));

    await ready(page, `/hosts/${hostId}`);
    await openConnection(page);

    // ⚠ THE DIFFERENCE FROM THE INSTALL DIALOG. That one runs before any agent has
    // connected, so it can only offer a choice and default to Linux. Here the host
    // has reported `darwin`, so the tab must open on macOS rather than guess.
    await expect(page.locator("[data-testid='agent-os-reported']")).toHaveText("darwin/arm64");
    await expect(page.locator("[data-testid='agent-os'] [data-state='active']")).toHaveText("macOS");

    const setup = page.locator("[data-testid='agent-env-command']");
    await expect(setup).toContainText("~/.zshrc");
    await expect(setup).not.toContainText("~/.bashrc");

    await page.locator("[data-testid='agent-os-linux']").click();
    await expect(setup).toContainText("~/.bashrc");

    // Same rule as the config block: this line is copyable, so it carries the
    // variable's NAME and a placeholder, never a secret.
    await expect(setup).toContainText("PDMUX_MCP_KEY");
    await expect(setup).not.toHaveText(KEY_SHAPE);
  });

  test("[TC-PDMCP-101] shows a new key once, and lists only its prefix afterwards", async ({ page }) => {
    const plaintext = "pdmux_mcp_ZZZZexampleZZZZexampleZZZZexampleZZ";
    const listed = {
      id: "00000000-0000-4000-8000-000000000002",
      hostId,
      label: "this machine's CLI",
      keyPrefix: "pdmux_mcp_ZZZZexam",
      scopes: ["read", "write"],
      expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    let minted = false;
    await page.route("**/api/hosts", (route) => route.fulfill({ json: [feedRow()] }));
        await page.route(`**/api/hosts/${hostId}/services`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/hosts/${hostId}/tokens`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/hosts/${hostId}/mcp-keys`, (route) => {
      if (route.request().method() === "POST") {
        minted = true;
        return route.fulfill({ json: { ...listed, key: plaintext } });
      }
      return route.fulfill({ json: minted ? [listed] : [] });
    });

    await ready(page, `/hosts/${hostId}`);
    await openConnection(page);
    await page.locator("[data-testid='agent-key-create']").click();

    // The one and only render of the plaintext.
    const revealed = page.locator("[data-testid='agent-key-revealed']");
    await expect(revealed).toBeVisible();
    await expect(page.locator("[data-testid='agent-key-plaintext']")).toHaveText(plaintext);

    await page.locator("[data-testid='agent-key-close']").click();
    await expect(revealed).toHaveCount(0);

    // ...and it is gone. The row names the key by its prefix, which is not enough
    // to reconstruct anything, and the full value is nowhere on the page.
    //
    // ⚠ THE LIST IS A `DataTable` NOW, and `agent-key-row` went with the hand-rolled
    // divs it replaced. The assertion never noticed because it was never reached —
    // the test died earlier, on a section it had not opened.
    const row = page.locator("[data-testid='agent-key-list'] tbody tr").first();
    await expect(row).toContainText("pdmux_mcp_ZZZZexam");
    expect(await page.locator("body").innerText()).not.toContain(plaintext);
  });
});
