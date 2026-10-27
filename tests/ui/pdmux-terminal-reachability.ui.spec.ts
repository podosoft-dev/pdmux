import { expect, test } from "../helpers/pdmux-test";
import { ready } from "../helpers/hydration";
import { mockHost } from "../helpers/fleet";

/**
 * A terminal in its own window says what its host is doing.
 *
 * It used to hard-code its host as online, so a machine that powered off left a pane that
 * looked alive and swallowed keystrokes. The window now reads its one host the way the
 * dashboard's feed does; the host is fabricated here so the test can turn it off and on.
 */
test.describe("pdmux detached terminal reachability", () => {
  test("[TC-PDVM-023] a detached terminal follows its host going away and coming back", async ({ page }) => {
    const host = mockHost("e2e-detached-reach");
    let online = true;
    await page.route(`**/api/hosts/${host.id}`, (route) => route.fulfill({ json: { ...host, online } }));
    // The host exists only in this page, so the real relay refuses its pane and the page
    // reports the server as lost three seconds later (`TransportLoss`). That state wins
    // over "host unreachable" on purpose, and it raced the offline check below: the run
    // failed whenever the poll that reads the host came after the grace period. Answer the
    // pane's socket here instead, as a relay that holds it open while the host is up.
    await page.routeWebSocket(/\/terminal\/ws/, () => {});

    await ready(page, `/terminal?host=${host.id}&kind=shell`);
    const pane = page.locator("[data-pdmux-pane]");
    await expect(pane).toBeVisible();
    await expect(pane).not.toHaveClass(/pdmux-unreachable/);

    online = false;
    await expect(pane, "the window still calls a powered-off host reachable").toHaveClass(/pdmux-unreachable/, {
      timeout: 12_000,
    });

    online = true;
    await expect(pane, "the window did not notice the host come back").not.toHaveClass(/pdmux-unreachable/, {
      timeout: 12_000,
    });
  });
});
