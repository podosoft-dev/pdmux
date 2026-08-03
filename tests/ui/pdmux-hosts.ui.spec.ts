import { expect, test } from "@playwright/test";
import { expectOnScreen, expectViewportBound } from "../helpers/geometry";
import { clickUntil, ready } from "../helpers/hydration";
import { openSidebar } from "../helpers/shell";
import { e2eAdminState, userState } from "../helpers/accounts";

/**
 * Host administration from the screen: the fleet is data in the product, not a
 * constant in a deployment script.
 *
 * The token flow is the part worth watching — the plaintext exists for exactly one
 * render, so the dialog has to hand over something usable (the install command)
 * before it is gone for good.
 *
 * These screens live INSIDE the shell, so the last two tests measure that: the cards
 * stay on the left, the list takes the terminals' place on the right, and moving
 * between the two never re-creates the frame around them.
 */

/** A marker written onto a live element; it survives only if the element does. */
type Marked = HTMLElement & { __pdmuxMark?: number };
const MARK = 4211;

const label = `e2e-host-${Date.now().toString().slice(-6)}`;
const enrollLabel = `e2e-host-enroll-${Date.now().toString().slice(-6)}`;

/**
 * A fleet row as `GET /hosts` returns it.
 *
 * The five version states cannot all be produced by real agents on one machine —
 * `ahead` needs a build newer than anything published and `incompatible` needs a
 * different wire contract — so the states themselves are served from a route mock.
 * The BEHAVIOUR under test is what the screen does with each one, which is exactly
 * what a fabricated row can drive.
 */
type MockHost = Record<string, unknown>;
function mockHost(label: string, overrides: MockHost = {}): MockHost {
  return {
    id: `00000000-0000-4000-8000-${label.replace(/\W/g, "").slice(-12).padStart(12, "0")}`,
    label,
    address: "10.9.9.9",
    agentAddress: null,
    description: null,
    tags: [],
    sortOrder: 0,
    enabled: true,
    agentVersion: "1.4.0",
    latestAgentVersion: "1.5.0",
    agentVersionState: "outdated",
    lastUpdate: null,
    os: "linux",
    arch: "amd64",
    capabilities: [],
    lastSeenAt: new Date().toISOString(),
    online: true,
    connected: true,
    resource: null,
    sessions: [],
    usage: [],
    services: [],
    ...overrides,
  };
}

/**
 * A `lastSeenAt` that far in the past.
 *
 * Fractional days on purpose: a whole number lands exactly on a day boundary, and
 * the countdown rounds up — so "26" and "26 days and a few milliseconds" would
 * disagree about whether four days or three remain.
 */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** An `updateStatus` frame as the agent reports it, with the pane counts that matter. */
function mockUpdate(shellPanes: number, sessionPanes: number): MockHost {
  return {
    commandId: "5f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    phase: "done",
    progressPct: null,
    currentVersion: "1.4.0",
    targetVersion: "1.4.0",
    code: null,
    message: "",
    shellPanes,
    sessionPanes,
  };
}

// Its own account, host and agent (see `E2E_ADMIN`): these specs write the dashboard
// layout, and sharing an account with a person rearranges their screen mid-session.
test.use({ storageState: e2eAdminState });


test.describe.serial("pdmux hosts", () => {
  test.afterAll(async ({ playwright, baseURL }) => {
    // The e2e account's own state, not `admin.json`: fleet rows are scoped per
    // account (`personal:<userId>`), so cleaning up as a different user lists a
    // different fleet and deletes nothing.
    const request = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    const hosts = (await (await request.get("/api/hosts")).json()) as { id: string; label: string }[];
    for (const host of hosts.filter((row) => row.label.startsWith("e2e-host-"))) {
      await request.delete(`/api/hosts/${host.id}`);
    }
    await request.dispose();
  });

  test("[TC-PDUI-130] registers a host from the UI", async ({ page }) => {
    await ready(page, "/hosts");
    await clickUntil(page, "[data-testid='host-add']", page.locator("[data-testid='host-label']"));
    await page.locator("[data-testid='host-label']").fill(label);
    await page.locator("[data-testid='host-address']").fill("10.9.9.9");
    await page.locator("[data-testid='host-save']").click();

    // Creating a host now opens the install dialog over the table (TC-PDUI-161):
    // a row is not a machine until something runs on the box. Dismiss it before
    // reading the list underneath.
    await expect(page.locator("[data-testid='enroll-dialog']")).toBeVisible();
    await page.locator("[data-testid='enroll-close']").click();
    await expect(page.locator("[data-testid='enroll-dialog']")).toHaveCount(0);

    const row = page.getByRole("row").filter({ hasText: label });
    await expect(row).toBeVisible();
    await expect(row).toContainText("10.9.9.9");
  });

  test("[TC-PDUI-131] mints a token and shows the install command once", async ({ page }) => {
    await ready(page, "/hosts");
    await page.getByRole("link", { name: label }).click();
    await expect(page.locator("[data-testid='host-title']")).toHaveText(label);

    await clickUntil(page, "[data-testid='token-mint']", page.locator("[data-testid='token-name']"));
    await page.locator("[data-testid='token-name']").fill("e2e-token");
    await page.locator("[data-testid='token-save']").click();

    const command = page.locator("[data-testid='token-install']");
    await expect(command).toBeVisible();
    // The plaintext is stored hashed, so this render is the only one there is —
    // it therefore carries the whole command, not a bare secret.
    await expect(command).toContainText("pdmux-agent install --server");
    await expect(command).toContainText("--token pdmux_");

    await page.locator("[data-testid='token-reveal-close']").click();
    await expect(page.getByRole("row").filter({ hasText: "e2e-token" })).toBeVisible();
    // Once dismissed the secret is gone for good: the row stays, the plaintext does not.
    await expect(command).toHaveCount(0);
  });

  test("[TC-PDUI-132] registers a service and links to it", async ({ page }) => {
    await ready(page, "/hosts");
    await page.getByRole("link", { name: label }).click();
    await clickUntil(page, "[data-testid='service-add']", page.locator("[data-testid='service-label']"));
    await page.locator("[data-testid='service-label']").fill("api");
    await page.locator("[data-testid='service-port']").fill("5002");
    await page.locator("[data-testid='service-save']").click();

    const row = page.getByRole("row").filter({ hasText: "api" });
    await expect(row).toBeVisible();
    // The card's launcher opens exactly this URL, so it is derived here too rather
    // than typed in a second place.
    await expect(row).toContainText("http://10.9.9.9:5002");
  });

  test("[TC-PDUI-200] folds the setup material without hiding what the page is for", async ({ page }) => {
    await ready(page, "/hosts");
    await page.getByRole("link", { name: label }).click();
    await expect(page.locator("[data-testid='host-title']")).toHaveText(label);

    // The connection block is 57% of this page and is read once when a CLI is
    // attached. Collapsed, its card is a heading and a summary.
    const connection = page.locator("[data-testid='host-connection']");
    await expect(connection).toBeVisible();
    await expect(page.locator("[data-testid='host-connection-summary']")).toBeVisible();
    await expect(page.locator("[data-testid='agent-access']")).toBeHidden();

    // ⚠ THE RULE THIS SPEC EXISTS FOR. Folding the page's weight is only allowed
    // where it does not bury the five actions that manage the host — burying them
    // is the bug the previous release fixed (pdui.md REQ-PDUI-008), and it would
    // be very easy to "tidy" this card away next.
    for (const id of ["host-edit", "host-install", "host-toggle-enabled", "host-move-open", "host-remove"]) {
      await expect(page.locator(`[data-testid='${id}']`)).toBeVisible();
    }

    // And the fold is a fold: opening it brings the whole block back.
    await page.locator("[data-testid='host-connection-toggle']").click();
    await expect(page.locator("[data-testid='agent-access']")).toBeVisible();
  });

  test("[TC-PDUI-201] says what the host is doing without leaving the page", async ({ page }) => {
    await ready(page, "/hosts");
    await page.getByRole("link", { name: label }).click();

    // Online/offline, last seen and os/arch used to live only on the sidebar card,
    // so the page named after the host could not answer "is it up?" — and on a
    // phone that card may not be on screen at all.
    const facts = page.locator("[data-testid='host-facts']");
    await expect(facts).toBeVisible();
    await expect(facts).toContainText("10.9.9.9");
    // A host that never connected has no last time; it must not print an epoch.
    await expect(page.locator("[data-testid='host-last-seen']")).not.toHaveText("");
  });

  test("[TC-PDUI-133] deleting a host requires typing its label", async ({ page }) => {
    await ready(page, "/hosts");
    await clickUntil(
      page,
      `[data-testid='host-menu-${label}']`,
      page.getByRole("menuitem", { name: /^(Delete|삭제)$/ }),
    );
    await page.getByRole("menuitem", { name: /^(Delete|삭제)$/ }).click();

    const confirm = page.locator("[data-testid='host-delete-confirm']");
    await expect(confirm).toBeDisabled();
    // Retyping the label is what proves the operator is looking at the row they
    // think they are — deleting a host takes its services, tokens and history.
    await page.locator("[data-testid='host-delete-input']").fill(label);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByRole("row").filter({ hasText: label })).toHaveCount(0);
  });

  test("[TC-PDUI-134] the host list renders beside the cards, and the page still does not scroll", async ({
    page,
  }) => {
    // The sidebar's collapse toggle lives in the dashboard's toolbar, so the
    // precondition has to be established there — on `/hosts` there is no switch to
    // reopen the column with, and a persisted collapse would fail this for the wrong
    // reason.
    await ready(page, "/");
    await openSidebar(page);
    await ready(page, "/hosts");
    const sidebar = page.locator("[data-pdmux-sidebar]");
    const panel = page.locator("[data-testid='hosts-panel']");
    await expect(page.locator("[data-testid='dashboard-shell']")).toBeVisible();
    await expectOnScreen(sidebar, "host sidebar on /hosts");
    await expectOnScreen(panel, "host list panel");

    // The list occupies the terminal grid's track: to the RIGHT of the cards, not
    // below them and not under them. Reading both boxes in one evaluate keeps the
    // comparison atomic if a splitter animation were ever added.
    const edges = await page.evaluate(() => {
      const left = document.querySelector("[data-pdmux-sidebar]")?.getBoundingClientRect();
      const right = document.querySelector("[data-testid='hosts-panel']")?.getBoundingClientRect();
      return { sidebarRight: Math.round(left?.right ?? -1), panelLeft: Math.round(right?.left ?? -1) };
    });
    expect(edges.sidebarRight).toBeGreaterThan(0);
    expect(edges.panelLeft, "the host list must start right of the sidebar").toBeGreaterThanOrEqual(
      edges.sidebarRight,
    );

    // Each column scrolls itself. The fixture cannot guarantee enough cards to
    // overflow here (TC-PDUI-121 does that on the dashboard), so this asserts the
    // contract rather than the symptom.
    const overflow = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector("[data-pdmux-sidebar]") as Element).overflowY,
      panel: getComputedStyle(document.querySelector("[data-testid='hosts-panel']") as Element).overflowY,
    }));
    expect(overflow.sidebar).toBe("auto");
    expect(overflow.panel).toBe("auto");
    await expectViewportBound(page);
  });

  test("[TC-PDUI-135] moving between the dashboard and the hosts page keeps the same shell", async ({ page }) => {
    await ready(page, "/");
    // The collapsed state is persisted, so establish the precondition instead of
    // assuming it — a collapsed column makes every assertion below fail for the wrong
    // reason.
    await openSidebar(page);
    const sidebar = page.locator("[data-pdmux-sidebar]");
    await expect(sidebar).toBeVisible();
    // Mark the live element: a client-side navigation inside the shell must not
    // re-create it. A document load or a re-mounted layout loses the property, which
    // is precisely the regression this guards (the sidebar used to be page content).
    await sidebar.evaluate((el: Marked, mark: number) => (el.__pdmuxMark = mark), MARK);

    await clickUntil(page, "[data-testid='nav-hosts']", page.locator("[data-testid='hosts-panel']"));
    await expect(page).toHaveURL(/\/hosts$/);
    await expect(page.locator("[data-testid='nav-hosts']")).toHaveAttribute("aria-current", "page");
    expect(await sidebar.evaluate((el: Marked) => el.__pdmuxMark ?? null)).toBe(MARK);

    // The compact breadcrumb is what replaced the old "back to the dashboard" button.
    await clickUntil(page, "[data-testid='open-dashboard']", page.locator("[data-pdmux-grid]"));
    await expect(page).toHaveURL((url) => url.pathname === "/");
    expect(await sidebar.evaluate((el: Marked) => el.__pdmuxMark ?? null)).toBe(MARK);
  });

  test("[TC-PDUI-161] registering a host hands over the one-line installer in one call, and regenerate replaces it", async ({
    page,
    baseURL,
  }) => {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL ?? "http://localhost:5001" });

    /**
     * The HOST and its FIRST CODE are both real — they arrive in one response, and
     * that is the behaviour under test. Only the REGENERATE is mocked.
     *
     * The plaintext exists for exactly one response, so a real second mint cannot be
     * re-read to compare against — and the assertion that matters there is what the
     * screen does with a replacement, which a fabricated one drives exactly. The
     * wire contract is still pinned: this route captures every request to the
     * enrollment collection, so the count below is what proves creation did NOT make
     * a second call. The endpoint's own behaviour (single use, replacement, expiry)
     * is covered by `agent-enrollments.service.spec.ts`.
     */
    const mints: string[] = [];
    await page.route("**/api/hosts/*/enrollments", (route) => {
      const code = `pdmxe_7Q4KM-9XZRB-8C3TF-N5HV${String(mints.length)}`;
      mints.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({
        json: {
          id: `00000000-0000-4000-8000-00000000000${mints.length}`,
          hostId: "00000000-0000-4000-8000-000000000000",
          status: "live",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          expiresInSec: 900,
          consumedAt: null,
          consumedIp: null,
          revokedAt: null,
          tokenId: null,
          createdAt: new Date().toISOString(),
          code,
          masked: "pdmxe_…N5HVW",
        },
      });
    });

    await ready(page, "/hosts");
    await clickUntil(page, "[data-testid='host-add']", page.locator("[data-testid='host-label']"));
    await page.locator("[data-testid='host-label']").fill(enrollLabel);
    await page.locator("[data-testid='host-save']").click();

    // The dialog opens FROM create. The previous flow closed the form and left the
    // operator on a list with no sign that a command still had to be run on the box.
    const dialog = page.locator("[data-testid='enroll-dialog']");
    await expect(dialog).toBeVisible();

    const command = page.locator("[data-testid='enroll-command']");
    await expect(command).toContainText("/install.sh | sh -s -- --code pdmxe_");

    // The code also stands alone: an operator already inside an ssh session types
    // this rather than pasting a command that would fetch the script again.
    const codeCell = page.locator("[data-testid='enroll-code']");
    await expect(codeCell).toContainText("pdmxe_");
    const first = ((await codeCell.textContent()) ?? "").trim();
    await expect(command).toContainText(first);

    // ...and it arrived WITH the host. `POST /hosts` answers with a live code, so one
    // operator action yields one thing to copy — the second request this screen used
    // to make is gone, and this route would have caught it.
    expect(mints).toEqual([]);

    await page.locator("[data-testid='enroll-command-copy']").click();
    // Read it back: the plaintext exists for one render, so "copy" has to actually
    // copy — `writeClipboard` also has to work where `navigator.clipboard` does not.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(first);

    // The code is short-lived, and the deadline is on screen rather than implied.
    await expect(page.locator("[data-testid='enroll-countdown']")).toContainText(/\d+:\d\d/);
    await expect(page.locator("[data-testid='enroll-status']")).toBeVisible();

    // Regenerate REPLACES: two live codes for one host would mean a mistyped one
    // still works, which is the whole reason minting retires the previous code.
    await page.locator("[data-testid='enroll-regenerate']").click();
    // The held code is dropped the moment a replacement is asked for — the dash is
    // the gap, and waiting for the new code to land is what proves it replaced.
    await expect(codeCell).not.toHaveText(first);
    await expect(codeCell).toContainText("pdmxe_");
    const second = ((await codeCell.textContent()) ?? "").trim();
    expect(second).not.toBe(first);
    await expect(command).toContainText(second);

    await page.locator("[data-testid='enroll-close']").click();
    await expect(dialog).toHaveCount(0);

    // Exactly ONE mint, and it is the regenerate — creation made none. The separate
    // endpoint stays as the escape hatch (expired code, dialog closed), and it is a
    // POST to the host's own enrollment collection, which is what retires the
    // previous code rather than adding a second live secret.
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatch(/^POST \/api\/hosts\/[0-9a-f-]{36}\/enrollments$/);
  });

  /**
   * The installer supports macOS on both architectures and always has — `install.sh`
   * reads `uname -s`/`uname -m` and registers a launchd job. What did not support it was
   * this dialog: it hardcoded `sha256sum`, which is coreutils and is NOT on a Mac. So the
   * one instruction whose entire purpose is "read it before you pipe it" was the one that
   * died with `command not found`, on the platform the operator was least sure about.
   *
   * Nothing real is created here — the fleet and the mint are both mocked, so the dialog
   * is driven without leaving a host behind on a shared stack.
   */
  test("[TC-PDUI-199] the install dialog writes commands for the host's OS, not for Linux only", async ({ page }) => {
    // Not yet arrived — which is the only state this dialog is read in. `mockHost`
    // defaults to a live agent, and for a connected host the dialog correctly replaces
    // the whole install block with "the agent is connected".
    const host = mockHost("mock-os", { online: false, connected: false, agentVersion: null });
    await page.route("**/api/hosts", (route) => route.fulfill({ json: [host] }));
    await page.route("**/api/hosts/*/enrollments", (route) =>
      route.fulfill({
        json: {
          id: "00000000-0000-4000-8000-000000000009",
          hostId: host.id,
          status: "live",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          expiresInSec: 900,
          consumedAt: null,
          consumedIp: null,
          revokedAt: null,
          tokenId: null,
          createdAt: new Date().toISOString(),
          code: "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW",
          masked: "pdmxe_…N5HVW",
        },
      }),
    );

    await ready(page, "/hosts");
    await clickUntil(page, "[data-testid='host-menu-mock-os']", page.locator("[data-testid='host-install-mock-os']"));
    await page.locator("[data-testid='host-install-mock-os']").click();
    await expect(page.locator("[data-testid='enroll-dialog']")).toBeVisible();

    const verify = page.locator("[data-testid='enroll-advanced-verify']");
    const note = page.locator("[data-testid='enroll-service-note']");
    const userHint = page.locator("[data-testid='enroll-user-hint']");
    await page.locator("[data-testid='enroll-advanced']").click();
    await expect(verify).toBeVisible();

    // Linux stays the default: most hosts are, and the previous behaviour is preserved.
    await expect(note).toContainText("systemd");
    await expect(verify).toContainText("sha256sum");
    await expect(userHint).toContainText("systemd --user");

    await page.locator("[data-testid='enroll-os-macos']").click();

    // The assertion that would have caught the bug: on macOS the snippet must not hand
    // the operator a tool that is not on their machine.
    await expect(verify).toContainText("shasum -a 256");
    await expect(verify).not.toContainText("sha256sum");
    await expect(note).toContainText("launchd");
    await expect(userHint).toContainText("LaunchAgent");

    // The install line is genuinely the same on both — `install.sh` does the detecting.
    // Asserting it is unchanged keeps a future "fix" from forking a command that has no
    // reason to differ.
    await expect(page.locator("[data-testid='enroll-command']")).toContainText(
      "/install.sh | sh -s -- --code pdmxe_",
    );

    // And the architecture is never a question the operator has to answer.
    await expect(note).toContainText("Apple Silicon");

    await page.locator("[data-testid='enroll-os-linux']").click();
    await expect(verify).toContainText("sha256sum");
  });

  test("[TC-PDUI-162] the version badge states decide which hosts are offered an update", async ({ page }) => {
    const hosts = [
      mockHost("mock-current", { agentVersion: "1.5.0", agentVersionState: "current" }),
      mockHost("mock-outdated", { agentVersionState: "outdated" }),
      mockHost("mock-ahead", { agentVersion: "1.6.0", agentVersionState: "ahead" }),
      mockHost("mock-unknown", { agentVersion: null, latestAgentVersion: null, agentVersionState: "unknown" }),
      mockHost("mock-incompatible", { agentVersionState: "incompatible" }),
    ];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await ready(page, "/hosts");
    await expect(page.getByRole("row").filter({ hasText: "mock-outdated" })).toBeVisible();

    // The badge is the verdict, not the number: `1.4.0` says nothing without knowing
    // what is published for that host's platform.
    for (const [name, wording] of [
      ["mock-current", /current|최신/],
      ["mock-outdated", /outdated|구버전/],
      ["mock-ahead", /ahead|앞섬/],
      ["mock-unknown", /unknown|알 수 없음/],
      ["mock-incompatible", /incompatible|호환/],
    ] as const) {
      await expect(page.getByRole("row").filter({ hasText: name })).toContainText(wording);
    }

    // ⚠ EVERY ROW TICKS, WHATEVER ITS VERSION SAYS. These were disabled on the version
    // verdict once, which made a fleet that is entirely up to date — the ordinary state
    // — a column of controls that never click under a blank header. The rule those
    // disabled boxes carried has not been dropped; it is enforced in the confirmation
    // now, where it can give a reason (TC-PDUI-187).
    for (const name of ["outdated", "incompatible", "unknown", "ahead", "current"]) {
      await expect(page.locator(`[data-testid='host-select-mock-${name}']`)).toBeEnabled();
    }

    // `ahead` is a developer on a local build; "update" there is a silent downgrade.
    for (const [name, offered] of [
      ["mock-outdated", true],
      ["mock-unknown", true],
      ["mock-incompatible", true],
      ["mock-ahead", false],
      ["mock-current", false],
    ] as const) {
      await clickUntil(
        page,
        `[data-testid='host-menu-${name}']`,
        page.getByRole("menuitem", { name: /^(Edit|수정)$/ }),
      );
      await expect(page.locator(`[data-testid='host-update-${name}']`)).toHaveCount(offered ? 1 : 0);
      await page.keyboard.press("Escape");
    }

    // Select-all is the COLUMN'S HEADING, so the column explains itself and the actions
    // do not have to sit on screen permanently to be found. Nothing else is there until
    // something is picked.
    await expect(page.locator("thead [data-testid='host-select-all']")).toBeVisible();
    await expect(page.locator("[data-testid='bulk-bar']")).toHaveCount(0);

    await page.locator("[data-testid='host-select-mock-outdated']").click();
    await expect(page.locator("[data-testid='bulk-count']")).toContainText("1");
    await expect(page.locator("[data-testid='bulk-update']")).toBeVisible();
    await expect(page.locator("[data-testid='bulk-delete']")).toBeVisible();
    // ...and leaves again with the last tick. A bar reading "0 selected" beside two dead
    // buttons is the spent control this screen has been cleared of twice.
    await page.locator("[data-testid='bulk-clear']").click();
    await expect(page.locator("[data-testid='bulk-bar']")).toHaveCount(0);
    await expect(page.locator("thead [data-testid='host-select-all']")).toBeVisible();
  });

  test("[TC-PDUI-189] select-all heads the column and tracks a partial selection", async ({ page }) => {
    /**
     * REPORTED: the selection bar was on screen at all times. It had to be, because it
     * was the only thing naming a column whose header was blank — so the fix is not to
     * hide the bar, it is to move select-all to where a reader already looks for it.
     *
     * ⚠ IT NEEDED AN EXTENSION TO `DataTable`, which is PodoKit output: one additive
     * `head` snippet on a column, so a column without one renders exactly as before.
     * That is worth a test of its own — the sortable and plain headers next to it must
     * keep working, or a shared table has been broken for every other screen.
     */
    const hosts = [mockHost("mock-1"), mockHost("mock-2"), mockHost("mock-3")];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await ready(page, "/hosts");
    await expect(page.getByRole("row").filter({ hasText: "mock-3" })).toBeVisible();

    const all = page.locator("thead [data-testid='host-select-all']");
    await expect(all).toBeVisible();
    // The other headers still render: a sortable one keeps its button, a plain one its
    // text. The `head` branch must not have swallowed them.
    await expect(page.locator("thead").getByRole("button", { name: /Label|이름|라벨/ })).toBeVisible();
    await expect(page.locator("thead")).toContainText(/Services|서비스/);

    // Empty selection is NOT "all selected" — `every()` on an empty set says otherwise,
    // which is how this control ends up ticked over a table it has not been used on.
    await expect(all).toHaveAttribute("data-state", "unchecked");

    await page.locator("[data-testid='host-select-mock-1']").click();
    // Partial is its own state: without it, one row of three leaves the header box empty
    // and nothing on screen says a selection exists.
    await expect(all).toHaveAttribute("data-state", "indeterminate");
    await expect(page.locator("[data-testid='bulk-count']")).toContainText("1");

    await all.click();
    await expect(all).toHaveAttribute("data-state", "checked");
    await expect(page.locator("[data-testid='bulk-count']")).toContainText("3");

    // And it clears everything, not just the rows it added.
    await all.click();
    await expect(all).toHaveAttribute("data-state", "unchecked");
    await expect(page.locator("[data-testid='bulk-bar']")).toHaveCount(0);
  });

  test("[TC-PDUI-190] the row drops what it cannot tell the reader", async ({ page }) => {
    /**
     * REPORTED, two things on the same row:
     *
     *   ADDRESS was blank or `127.0.0.1`. The blank is honest; the loopback is worse
     *   than blank, because it reads as an answer while every host on the screen would
     *   give that same one about itself.
     *
     *   AGENT carried "updated" — the `done` phase — beside a version number that IS
     *   the new version and a badge that already reads `current`. And permanently:
     *   `lastUpdate` is overwritten only by the next update.
     *
     * ⚠ ASSERTED IN THE BROWSER because the verdicts passing says nothing about what
     * the cells render, and each one has a control on the same screen that MUST still
     * show — otherwise this passes by rendering nothing at all.
     */
    const hosts = [
      mockHost("mock-loopback", {
        address: "127.0.0.1",
        agentVersion: "1.5.0",
        agentVersionState: "current",
        lastUpdate: { ...mockUpdate(0, 0), phase: "done", currentVersion: "1.5.0", targetVersion: "1.5.0" },
      }),
      mockHost("mock-nowhere", { address: null }),
      // No operator address, but the host itself said where it can be reached — the
      // only way this cell can fill itself in, because a server only ever sees the far
      // end of a socket the agent dialled out through.
      mockHost("mock-reported", { address: null, agentAddress: "172.31.6.118" }),
      // Both. The operator typed theirs on purpose and it is what service links are
      // built from, so an agent must not quietly replace the name they chose.
      mockHost("mock-both", { address: "build-01.internal", agentAddress: "10.9.9.9" }),
      // The controls. If these stopped rendering too, the assertions above would pass
      // for the wrong reason.
      mockHost("mock-routable", { address: "10.4.4.9" }),
      mockHost("mock-busy", {
        lastUpdate: { ...mockUpdate(0, 0), phase: "downloading", progressPct: 40, targetVersion: "1.5.0" },
      }),
    ];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await ready(page, "/hosts");
    await expect(page.getByRole("row").filter({ hasText: "mock-busy" })).toBeVisible();

    const row = (name: string) => page.getByRole("row").filter({ hasText: name });

    // A real address still shows — the rule is "meaningless", not "hidden".
    await expect(row("mock-routable")).toContainText("10.4.4.9");
    await expect(row("mock-loopback")).not.toContainText("127.0.0.1");
    // Both the loopback and the absent one land in the same honest place — unless the
    // host itself answered, which is the whole point of asking it.
    for (const name of ["mock-loopback", "mock-nowhere"]) {
      await expect(row(name).locator("td").nth(2)).toHaveText("—");
    }
    await expect(row("mock-reported").locator("td").nth(2)).toHaveText("172.31.6.118");
    await expect(row("mock-both").locator("td").nth(2)).toHaveText("build-01.internal");

    // A finished update says nothing the two cells beside it have not already said...
    await expect(row("mock-loopback")).not.toContainText(/updated|업데이트됨/);
    await expect(row("mock-loopback").locator("[data-testid^='agent-update-status-']")).toHaveCount(0);
    await expect(row("mock-loopback")).toContainText("1.5.0");
    await expect(row("mock-loopback")).toContainText(/current|최신/);
    // ...while a running one is the only report there is.
    await expect(row("mock-busy").locator("[data-testid^='agent-update-status-']")).toBeVisible();
    await expect(row("mock-busy")).toContainText("40");
  });

  test("[TC-PDUI-187] a batch names every host it will move, and every one it will not", async ({ page }) => {
    /**
     * REPORTED: the checkboxes did nothing. They were gated on "could this host be
     * updated", so a fleet that is entirely up to date left every box on the screen
     * disabled — a column of dead controls under a blank header, which reads as a
     * broken table.
     *
     * Selection is free now, so the confirmation carries the weight the disabled state
     * used to. ⚠ THE SKIPPED LIST IS THE POINT, not decoration: an operator who ticks
     * five rows and is told afterwards that two updated has been given the outcome of
     * something they never agreed to. And `unknown` — a version we could not read — is
     * still kept out of a batch; it is simply refused out loud now.
     */
    const hosts = [
      mockHost("mock-a"),
      mockHost("mock-b", { agentVersionState: "incompatible" }),
      mockHost("mock-done", { agentVersion: "1.5.0", agentVersionState: "current" }),
      mockHost("mock-blind", { agentVersion: null, latestAgentVersion: null, agentVersionState: "unknown" }),
      mockHost("mock-dark", { online: false }),
    ];
    let sent: unknown = null;
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await page.route("**/api/fleet/agent/update", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({
        json: { version: "1.5.0", requested: 2, started: [], failed: [], notAttempted: [], stopped: false, summary: "" },
      });
    });
    await ready(page, "/hosts");
    // ⚠ WAIT FOR THE MOCKED FLEET TO BE THE ONE ON SCREEN. The route only intercepts
    // the browser's poll, so the first paint is the server-rendered real fleet — and
    // select-all takes the rows it can see. Clicking too early selects those instead,
    // they vanish on the next poll, and the count reads 0. Measured: this test failed
    // exactly once that way before the wait was here.
    await expect(page.getByRole("row").filter({ hasText: "mock-blind" })).toBeVisible();
    await expect(page.locator("tbody [data-testid^='host-select-']")).toHaveCount(hosts.length);

    // Select-all reaches every row, including the three a batch will not move.
    await page.locator("[data-testid='host-select-all']").click();
    await expect(page.locator("[data-testid='bulk-count']")).toContainText("5");

    await page.locator("[data-testid='bulk-update']").click();
    const dialog = page.locator("[data-testid='bulk-update-dialog']");
    await expect(dialog).toBeVisible();
    // The target version, said once, for the whole batch.
    await expect(page.locator("[data-testid='bulk-update-target']")).toContainText("1.5.0");

    const willUpdate = page.locator("[data-testid='bulk-update-list']");
    await expect(willUpdate).toContainText("mock-a");
    await expect(willUpdate).toContainText("mock-b");

    const skipped = page.locator("[data-testid='bulk-update-skipped']");
    for (const name of ["mock-done", "mock-blind", "mock-dark"]) {
      await expect(skipped).toContainText(name);
    }
    // Named reasons, not a bare count — "3 skipped" sends somebody hunting the table.
    await expect(skipped).toContainText(/current|최신/);
    await expect(skipped).toContainText(/unreadable|읽을 수 없음/);
    await expect(skipped).toContainText(/offline|오프라인/);

    await page.locator("[data-testid='bulk-update-confirm']").click();
    await expect(dialog).toHaveCount(0);
    // ⚠ ONLY THE TWO. If the skipped hosts reached the wire, every word in that dialog
    // was a lie and the batch touched machines nobody agreed to.
    expect(sent).toEqual({
      hostIds: [hosts[0]!.id, hosts[1]!.id],
      version: "1.5.0",
    });
  });

  test("[TC-PDUI-191] a batch that needs a canary says so before the click", async ({ page }) => {
    /**
     * REPORTED: pressing update on a freshly published version looked like it did
     * nothing at all. The server answers NO_CANARY (409) when no host is already
     * running the target — "update a single host first, then roll it out" — and that
     * only arrived as a toast, after a dialog that had listed every host and taken the
     * confirmation. Measured on a real rollout of a new agent build.
     *
     * ⚠ THE RULE IS NOT BEING WEAKENED, only moved forward. A build nobody has run
     * must not reach every machine at once; the operator just gets to know that while
     * the dialog is still open.
     */
    const fleet = [
      mockHost("mock-old-a", { agentVersion: "1.4.0" }),
      mockHost("mock-old-b", { agentVersion: "1.4.0" }),
    ];
    let sent = 0;
    await page.route("**/api/hosts", (route) => route.fulfill({ json: fleet }));
    await page.route("**/api/fleet/agent/update", (route) => {
      sent += 1;
      return route.fulfill({ status: 409, json: { success: false, error: { code: "NO_CANARY" } } });
    });
    await ready(page, "/hosts");
    await expect(page.getByRole("row").filter({ hasText: "mock-old-b" })).toBeVisible();

    await page.locator("[data-testid='host-select-all']").click();
    await page.locator("[data-testid='bulk-update']").click();
    await expect(page.locator("[data-testid='bulk-update-dialog']")).toBeVisible();

    // Said in the dialog, and the batch cannot be sent from here.
    await expect(page.locator("[data-testid='bulk-update-canary']")).toBeVisible();
    await expect(page.locator("[data-testid='bulk-update-confirm']")).toBeDisabled();
    await page.locator("[data-testid='bulk-update-confirm']").click({ force: true }).catch(() => {});
    expect(sent, "the batch was sent to a server that would refuse it").toBe(0);
    await page.locator("[data-testid='bulk-update-cancel']").click();

    // ⚠ THE CONTROL. One host on the target version satisfies the server, so the same
    // selection must go through — otherwise this passes by disabling the button always.
    await page.unroute("**/api/hosts");
    await page.route("**/api/hosts", (route) =>
      route.fulfill({ json: [mockHost("mock-old-a", { agentVersion: "1.4.0" }), mockHost("mock-canary", { agentVersion: "1.5.0", agentVersionState: "current" })] }),
    );
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: "mock-canary" })).toBeVisible();
    await page.locator("[data-testid='host-select-all']").click();
    await page.locator("[data-testid='bulk-update']").click();
    await expect(page.locator("[data-testid='bulk-update-canary']")).toHaveCount(0);
    await expect(page.locator("[data-testid='bulk-update-confirm']")).toBeEnabled();
  });

  test("[TC-PDUI-188] deleting a batch lists it and gates on the count", async ({ page }) => {
    /**
     * Deleting a host takes its services, tokens, enrollment code and history with it,
     * and the machine is refused until somebody registers it again — so the single-row
     * delete makes the operator retype the label. A batch cannot ask for eleven labels,
     * and the thing you can be wrong about is HOW MANY, so the count is what is retyped
     * and the list above it is what makes that number checkable.
     *
     * ⚠ ROUTE-MOCKED ON PURPOSE. This asserts the requests the page WOULD send; a real
     * run would delete rows from the fleet this deployment is actually using.
     */
    const hosts = [mockHost("mock-x"), mockHost("mock-y"), mockHost("mock-z")];
    const deleted: string[] = [];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await page.route("**/api/hosts/*", (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleted.push(route.request().url().split("/").pop() as string);
      return route.fulfill({ json: { id: "x", label: "x" } });
    });
    await ready(page, "/hosts");
    // The mocked fleet has to be the one on screen before anything is ticked — see the
    // note in TC-PDUI-187: the route intercepts the poll, not the server render.
    await expect(page.getByRole("row").filter({ hasText: "mock-z" })).toBeVisible();

    await page.locator("[data-testid='host-select-mock-x']").click();
    await page.locator("[data-testid='host-select-mock-y']").click();
    await page.locator("[data-testid='bulk-delete']").click();

    const dialog = page.locator("[data-testid='bulk-delete-confirm']");
    await expect(dialog).toBeVisible();
    // Every label it is about to take, so the count below is checkable.
    await expect(page.locator("[data-testid='bulk-delete-list']")).toContainText("mock-x");
    await expect(page.locator("[data-testid='bulk-delete-list']")).toContainText("mock-y");
    await expect(page.locator("[data-testid='bulk-delete-list']")).not.toContainText("mock-z");

    const confirm = page.locator("[data-testid='bulk-delete-confirm-confirm']");
    await expect(confirm).toBeDisabled();
    // The wrong number does not arm it — otherwise the gate is a second button wearing
    // a text field, which is precisely what the single-row gate exists not to be.
    await page.locator("[data-testid='bulk-delete-confirm-input']").fill("3");
    await expect(confirm).toBeDisabled();
    await page.locator("[data-testid='bulk-delete-confirm-input']").fill("2");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(dialog).toHaveCount(0);
    expect(deleted.sort()).toEqual([hosts[0]!.id, hosts[1]!.id].sort());
  });

  test("[TC-PDUI-186] a failure the host has moved past leaves the screen", async ({ page }) => {
    /**
     * REPORTED: a host read "update failed · NOT_NEWER" on this screen while running
     * the newest published agent. Nothing had malfunctioned — the agent refused a
     * DOWNGRADE (target 0.1.0, running 0.1.1), which is what that refusal is for. The
     * defect is that the refusal never left: `lastUpdate` is one column overwritten only
     * by the next update, and a host that is `current` is offered no update, so nothing
     * could overwrite it. A permanent alarm on a host with nothing wrong with it.
     *
     * ⚠ ASSERTED IN THE BROWSER AND NOT ONLY IN THE UNIT SPEC, because the pure verdict
     * passing says nothing about whether the CELL stopped drawing the line — the two are
     * separate edits and only one of them is what the operator sees.
     */
    const hosts = [
      // The live row, exactly.
      mockHost("mock-caught-up", {
        agentVersion: "0.1.1",
        latestAgentVersion: "0.1.1",
        agentVersionState: "current",
        lastUpdate: {
          ...mockUpdate(0, 0),
          phase: "failed",
          code: "NOT_NEWER",
          currentVersion: "0.1.1",
          targetVersion: "0.1.0",
          message: "0.1.0 is not newer than the running 0.1.1 (use force for a deliberate downgrade)",
        },
      }),
      // ⚠ THE CONTROL, and the more important half. A host still BELOW the version that
      // failed keeps its line: that is the only place a rollout which silently did
      // nothing becomes visible, and hiding one of those would be the worse bug.
      mockHost("mock-still-behind", {
        agentVersion: "1.4.0",
        agentVersionState: "outdated",
        lastUpdate: {
          ...mockUpdate(0, 0),
          phase: "failed",
          code: "VERIFY_FAILED",
          currentVersion: "1.4.0",
          targetVersion: "1.5.0",
        },
      }),
    ];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await ready(page, "/hosts");

    const caughtUp = page.getByRole("row").filter({ hasText: "mock-caught-up" });
    const behind = page.getByRole("row").filter({ hasText: "mock-still-behind" });
    await expect(behind).toBeVisible();

    // The control first: if this line were missing the test below would pass for the
    // wrong reason — a cell that renders no outcome at all.
    await expect(behind).toContainText("VERIFY_FAILED");
    await expect(behind.locator("[data-testid^='agent-update-status-']")).toBeVisible();

    await expect(caughtUp).not.toContainText("NOT_NEWER");
    await expect(caughtUp.locator("[data-testid^='agent-update-status-']")).toHaveCount(0);
    // The row still says what it IS — only the spent alarm goes.
    await expect(caughtUp).toContainText(/current|최신/);
    await expect(caughtUp).toContainText("0.1.1");
  });

  test("[TC-PDUI-163] the update confirmation names pane counts and gates on shell panes", async ({ page }) => {
    const hosts = [
      mockHost("mock-shells", { lastUpdate: mockUpdate(2, 3) }),
      mockHost("mock-quiet", { lastUpdate: mockUpdate(0, 1) }),
    ];
    const sent: string[] = [];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await page.route("**/api/hosts/*/agent/update", (route) => {
      sent.push(route.request().url());
      return route.fulfill({
        json: {
          hostId: "mock",
          label: "mock",
          commandId: "5f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
          version: "1.5.0",
          artifactPath: "/agent/1.5.0/pdmux-agent-linux-amd64",
          sha256: "0".repeat(64),
          bytes: 1,
          os: "linux",
          arch: "amd64",
        },
      });
    });
    await ready(page, "/hosts");
    await expect(page.getByRole("row").filter({ hasText: "mock-shells" })).toBeVisible();

    await clickUntil(
      page,
      "[data-testid='host-menu-mock-shells']",
      page.locator("[data-testid='host-update-mock-shells']"),
    );
    await page.locator("[data-testid='host-update-mock-shells']").click();

    // Numbers, not a warning. "This may disconnect terminals" is true every time and
    // is therefore read once and clicked through forever.
    const panes = page.locator("[data-testid='agent-update-panes']");
    await expect(panes).toBeVisible();
    await expect(panes).toContainText("2");
    await expect(panes).toContainText("3");

    // Shell panes are the unrecoverable half, so the first press only arms the gate.
    await page.locator("[data-testid='agent-update-confirm']").click();
    await expect(page.locator("[data-testid='agent-update-second']")).toBeVisible();
    expect(sent, "no update may be sent by the first press when shell panes would die").toHaveLength(0);

    await page.locator("[data-testid='agent-update-confirm-shells']").click();
    await expect.poll(() => sent.length).toBe(1);

    // With nothing to lose, one press is proportionate — the gate is on the count,
    // not on a preference that could be turned off into irrelevance.
    await clickUntil(
      page,
      "[data-testid='host-menu-mock-quiet']",
      page.locator("[data-testid='host-update-mock-quiet']"),
    );
    await page.locator("[data-testid='host-update-mock-quiet']").click();
    await expect(page.locator("[data-testid='agent-update-panes']")).toContainText("0");
    await page.locator("[data-testid='agent-update-confirm']").click();
    await expect.poll(() => sent.length).toBe(2);
    await expect(page.locator("[data-testid='agent-update-dialog']")).toHaveCount(0);
  });

  test("[TC-PDWEB-017] a host that never connected is its own state, and can be asked for", async ({ page }) => {
    /**
     * THE RULE: `lastSeenAt === null` means the installer was never run on that
     * machine. `hostState()` collapses it into `offline` — the same word as a host
     * that died five minutes ago — and that is left alone on purpose, because the
     * cards are built on its three-value contract. So the list is where the two are
     * told apart: a marker in the last-seen column, and a filter that can select them.
     *
     * ⚠ THE STATE COLUMN AGREEING IS PART OF THE ASSERTION, not an oversight. Both
     * rows read "offline" there; if a future change makes them differ, the distinction
     * has moved into `hostState()` and every card in the product moved with it.
     */
    const hosts = [
      mockHost("mock-live", { lastSeenAt: new Date().toISOString(), online: true }),
      mockHost("mock-quiet", { lastSeenAt: daysAgoIso(40), online: false }),
      // Registered, never enrolled: the row exists, the machine has never spoken.
      mockHost("mock-fresh-install", { lastSeenAt: null, online: false, agentVersion: null }),
    ];
    await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
    await ready(page, "/hosts");
    // The route intercepts the POLL, not the server render — wait for the mocked
    // fleet to be the one on screen before reading anything off it.
    await expect(page.getByRole("row").filter({ hasText: "mock-fresh-install" })).toBeVisible();

    // It is a marker, not grey text the eye slides over.
    const never = page.locator("[data-testid='host-never-mock-fresh-install']");
    await expect(never).toBeVisible();
    await expect(never).toContainText(/Never connected|접속한 적 없음/);
    // ...and it is about `lastSeenAt`, not about being offline: the 40-day-old host
    // does not get one. Without this the marker could be painted on every row.
    await expect(page.locator("[data-testid='host-never-mock-quiet']")).toHaveCount(0);
    await expect(page.locator("[data-testid='host-never-mock-live']")).toHaveCount(0);

    // Both still say "offline" in the state column — see the note above.
    for (const label of ["mock-quiet", "mock-fresh-install"]) {
      await expect(page.getByRole("row").filter({ hasText: label })).toContainText(/offline|오프라인/);
    }

    // The filter: second select in the toolbar, committed with the others on Search.
    const seenFilter = page.locator("[data-testid='hosts-panel'] button[data-slot='select-trigger']").nth(1);
    const searchButton = page.getByRole("button", { name: /^(Search|검색)$/ });

    await seenFilter.click();
    await page.getByRole("option", { name: /Never connected|접속한 적 없음/ }).click();
    // Nothing applies per keystroke or per selection — the toolbar commits on Search.
    await expect(page.getByRole("row").filter({ hasText: "mock-quiet" })).toBeVisible();
    await searchButton.click();
    await expect(page.getByRole("row").filter({ hasText: "mock-fresh-install" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "mock-quiet" })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "mock-live" })).toHaveCount(0);

    // ⚠ THE CONTROL. A predicate that always answers "never" would pass the block
    // above; asking for the opposite bucket has to select the opposite row.
    await seenFilter.click();
    await page.getByRole("option", { name: /Within 7 days|7일 이내/ }).click();
    await searchButton.click();
    await expect(page.getByRole("row").filter({ hasText: "mock-live" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "mock-fresh-install" })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "mock-quiet" })).toHaveCount(0);
  });

  test("[TC-PDWEB-018] the list warns before the sweep takes a host", async ({ page, playwright, baseURL }) => {
    /**
     * Automatic removal is opt-in and irreversible — the delete cascades to the
     * host's tokens, so the machine is refused until somebody re-runs the installer.
     * The whole justification for having it at all is that the list says so first
     * (Tailscale shows last-seen and lets you filter on it rather than deleting
     * quietly), so the notice is what this measures.
     *
     * ⚠ THE SETTING IS READ BY THE SERVER LOADER, so `page.route` cannot fabricate
     * it — it is written through the API for this suite's own account and put back
     * in `finally`. Rows are still mocked: nothing here waits on a real agent.
     */
    const request = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    try {
      await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 30 } });

      const hosts = [
        mockHost("mock-seen-today", { lastSeenAt: new Date().toISOString(), online: true }),
        // 3.5 days of the 30-day window left: inside the seven days of notice.
        mockHost("mock-seen-26d", { lastSeenAt: daysAgoIso(26.5), online: false }),
        mockHost("mock-seen-40d", { lastSeenAt: daysAgoIso(40), online: false }),
        mockHost("mock-no-agent", { lastSeenAt: null, online: false }),
      ];
      await page.route("**/api/hosts", (route) => route.fulfill({ json: hosts }));
      await ready(page, "/hosts");
      await expect(page.getByRole("row").filter({ hasText: "mock-no-agent" })).toBeVisible();

      // Past the window: gone at the next sweep.
      await expect(page.locator("[data-testid='host-removal-mock-seen-40d']")).toContainText(
        /Removal due|삭제 예정/,
      );
      // Still inside it, with the days remaining — a warning that arrives the hour
      // before the reaper is not a warning.
      await expect(page.locator("[data-testid='host-removal-mock-seen-26d']")).toContainText(
        /Removal in 4d|4일 후 삭제/,
      );
      // Not threatened, and for two different reasons: one reported today, and one
      // has no `lastSeenAt` at all — the server's `lastSeenAt < cutoff` can never
      // match a NULL, so a host that never connected is never swept.
      await expect(page.locator("[data-testid='host-removal-mock-seen-today']")).toHaveCount(0);
      await expect(page.locator("[data-testid='host-removal-mock-no-agent']")).toHaveCount(0);

      // ⚠ THE CONTROL, and it is the shipped default: with removal off, NOTHING may
      // be marked. Without this the assertions above pass against a column that
      // warns unconditionally.
      await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 0 } });
      await page.reload();
      await expect(page.getByRole("row").filter({ hasText: "mock-seen-40d" })).toBeVisible();
      await expect(page.locator("[data-testid^='host-removal-']")).toHaveCount(0);
    } finally {
      // Back to the default whatever happened above: leaving a suite account armed
      // would let a later run delete rows nobody pointed at.
      await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 0 } });
      await request.dispose();
    }
  });
});


/**
 * A member's fleet is their own machines, so they may register one.
 *
 * Requiring an administrator here protected nobody: with no organization every account
 * sits in its own `personal:<userId>` scope, so the fleet a member was refused write
 * access to was their own — and empty. They could not add a laptop, and nobody could
 * add one for them without it landing in the wrong scope.
 *
 * The affordance is drawn from `canManage`, which the server answers (`/fleet/scope`)
 * because the rule needs the active organization and the loader cannot see it.
 */
test.describe("pdmux hosts (member)", () => {
  test.use({ storageState: userState });

  test("[TC-PDUI-198] a member is offered the way to register their own machine", async ({ page }) => {
    await ready(page, "/");
    await openSidebar(page);

    // Both entry points, because they are gated separately: the tile at the end of the
    // card list, and the `+` in the sidebar's control row.
    await expect(page.locator("[data-pdmux-add-host]")).toBeVisible();
    await expect(page.locator("[data-testid='host-add-sidebar']")).toBeVisible();

    // And it leads somewhere: the dialog opens rather than the button answering 403.
    await page.locator("[data-testid='host-add-sidebar']").click();
    await expect(page.locator("[data-testid='host-label']")).toBeVisible();
  });
});
