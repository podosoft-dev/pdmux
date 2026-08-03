import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";
import { e2eAdminState } from "../helpers/accounts";

/**
 * The screen that mints a credential reaching every host a person can see.
 *
 * Two of the three assertions here are NEGATIVE, and that is not a stylistic
 * preference — a positive assertion cannot see either failure. "The plaintext is
 * shown" passes whether or not it is ALSO left on the page behind the dialog, and
 * "the tier the person may have is offered" passes whether the ones they may not
 * are disabled or simply absent. Both failures are silent and both are the ones
 * that cost something.
 */
test.use({ storageState: e2eAdminState });

/** Any real token starts like this; a fixture must never match it by accident. */
const TOKEN_SHAPE = /pdmux_usr_[A-Za-z0-9_-]{20}/;

const POLICY = "**/api/account/mcp-tokens/policy";
const TOKENS = "**/api/account/mcp-tokens";

/**
 * Not `.serial`: these share nothing. Each mocks both endpoints itself and creates
 * no server state, so an independent run means one failure reports one defect rather
 * than hiding the two tests behind it.
 */
test.describe("coding CLI access", () => {
  /**
   * ⚠ THE CEILING IS MOCKED, NOT ARRANGED. This suite runs as the sole owner of a
   * personal fleet, whose ceiling is `admin` — so the account can never produce the
   * state this screen's hardest rule is about. Demoting a real account to reach it
   * would be the suite rewriting its own fixtures, which is the thing that took
   * somebody's login away on 2026-07-29.
   *
   * What is under test is what the SCREEN does with a ceiling, and the screen learns
   * the ceiling from this one response. Mocking it drives exactly the branch and
   * touches nobody's account.
   */
  test("[TC-PDMCP-103] shows a tier it cannot grant as refused, not as absent", async ({ page }) => {
    await page.route(POLICY, (route) => route.fulfill({ json: { ceiling: "read", enabled: true, expiryDays: [7, 30, 90] } }));
    await page.route(TOKENS, (route) => route.fulfill({ json: [] }));

    await ready(page, "/access");

    // ⚠ THIS ONE IS ASSERTED WITH THE LIST CLOSED, and that is the point. A select
    // shows nothing until it is opened, so disabled items alone would leave a person
    // with no idea why the tier they wanted is unavailable — and the 403 they would
    // eventually get would arrive bare.
    await expect(page.locator("[data-testid='mcp-tier-blocked']")).toBeVisible();

    await page.locator("[data-testid='mcp-token-tier']").click();
    // Present, so the permission model is legible from inside the list too: a person
    // can see that Operate and Admin exist and are not theirs to grant.
    for (const tier of ["read", "operate", "admin"]) {
      await expect(page.locator(`[data-testid='mcp-tier-${tier}']`)).toBeVisible();
    }
    await expect(page.locator("[data-testid='mcp-tier-read']")).not.toHaveAttribute("data-disabled", "");
    await expect(page.locator("[data-testid='mcp-tier-operate']")).toHaveAttribute("data-disabled", "");
    await expect(page.locator("[data-testid='mcp-tier-admin']")).toHaveAttribute("data-disabled", "");
    await page.keyboard.press("Escape");

    // The selection follows the ceiling down: the form defaults to `operate`, and
    // submitting that would ask for a tier the server is about to refuse.
    await expect(page.locator("[data-testid='mcp-token-tier']")).toContainText("Read only");
  });

  /**
   * ⚠ THE ASSERTION IS THE ONE AFTER THE DIALOG CLOSES. A screen that renders the
   * plaintext into the table as well as the dialog passes every other check in this
   * file — it appears once, it is copyable, it is correct — and leaves a fleet-wide
   * credential on a page that stays open all day.
   */
  test("[TC-PDMCP-103] shows the plaintext once and never again", async ({ page }) => {
    const token = "pdmux_usr_e2eFAKEtoken0123456789";
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      label: "e2e",
      keyPrefix: "pdmux_usr_e2eF",
      tier: "read",
      effectiveTier: "read",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      expiringSoon: false,
      lastUsedAt: null,
      revokedAt: null,
    };
    await page.route(POLICY, (route) => route.fulfill({ json: { ceiling: "admin", enabled: true } }));
    let minted = false;
    await page.route(TOKENS, (route) => {
      if (route.request().method() === "POST") {
        minted = true;
        return route.fulfill({ json: { ...row, token } });
      }
      return route.fulfill({ json: minted ? [row] : [] });
    });

    await ready(page, "/access");
    await page.locator("[data-testid='mcp-token-form'] input").first().fill("e2e");
    await page.locator("[data-testid='mcp-token-create']").click();

    const dialog = page.locator("[data-testid='mcp-token-revealed']");
    await expect(dialog).toBeVisible();
    await expect(page.locator("[data-testid='mcp-token-plaintext']")).toHaveText(token);

    await page.locator("[data-testid='mcp-token-close']").click();
    await expect(dialog).toBeHidden();

    // Gone from the DOM, not merely from view — `textContent` sees a hidden node.
    await expect(page.locator("body")).not.toContainText(token);
    // And the row that remains points at the token by its prefix only.
    await expect(page.locator("[data-testid='mcp-tokens']")).toContainText(row.keyPrefix);
  });

  /**
   * ⚠ THE SHELL PLACES ITS CHILDREN BY ROLE, AND SCROLLING IS NOT AUTOMATIC.
   *
   * This screen shipped as a bare `<div>`: no `data-pdmux-region`, so the shell had
   * nowhere to put it, and no scroll container, so as a grid child it refused to
   * shrink below its content. Everything past the endpoint card was cut off with no
   * way to reach it — the token list was in the DOM and could not be scrolled to,
   * which is why every other assertion in this file passed while the screen was
   * unusable. Reported from the deployment.
   */
  test("[TC-PDMCP-103] is placed by the shell, and the list below the fold can be reached", async ({ page }) => {
    const row = (n: number) => ({
      id: `0000000${n}-1111-4111-8111-111111111111`,
      label: `token ${n}`,
      keyPrefix: `pdmux_usr_row${n}`,
      tier: "read",
      effectiveTier: "read",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      expiringSoon: false,
      lastUsedAt: null,
      revokedAt: null,
    });
    await page.route(POLICY, (route) => route.fulfill({ json: { ceiling: "admin", enabled: true, expiryDays: [7, 30, 90] } }));
    // Enough rows that the page must overflow. An empty list fits, and a screen that
    // fits cannot demonstrate anything about a screen that does not.
    await page.route(TOKENS, (route) => route.fulfill({ json: Array.from({ length: 8 }, (_, i) => row(i)) }));

    await ready(page, "/access");

    const panel = page.locator("[data-testid='mcp-tokens']");
    await expect(panel).toHaveAttribute("data-pdmux-region", "page");

    // The way back. Every other full-screen route carries one; this one did not, so
    // the only exit was the browser's own back button.
    const crumb = page.locator("[data-testid='open-dashboard']");
    await expect(crumb).toBeVisible();
    await expect(crumb).toHaveAttribute("href", "/");

    /**
     * ⚠ THE CONTAINER HAS TO ACTUALLY SCROLL, and that is a different question from
     * whether it says `overflow-y: auto`.
     *
     * A flex column shrinks its children by default, so the cards were squeezed to fit
     * the viewport rather than overflowing it — `scrollHeight` equalled `clientHeight`
     * with nothing to scroll, while the cards, being `overflow-hidden`, clipped their
     * own contents. Measured at 1440x900: 900 against 900, with the token list sitting
     * at y=763..928.
     *
     * ⚠ AND THE FIRST VERSION OF THIS TEST ASSERTED ON THE FORM, which sat at
     * y=402..834 — inside the viewport the whole time. It passed against the broken
     * screen. The thing that was cut off is the LAST element, so that is what this
     * looks at.
     */
    const scroll = await panel.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(scroll.scrollHeight, "the page does not scroll, so its cards were squeezed instead").toBeGreaterThan(
      scroll.clientHeight,
    );

    await panel.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(page.locator("[data-testid='mcp-tokens'] table")).toBeInViewport();
  });

  /**
   * The block a person copies is the single most likely thing on this screen to end
   * up committed, so it carries the environment variable's NAME and nothing else.
   *
   * ⚠ AND THE NAME IS `PDMUX_MCP_TOKEN`, NOT `PDMUX_MCP_KEY`. One person can hold
   * both kinds at once — a host key for one machine and this for the fleet — and a
   * shared name makes whichever was exported last the one that answers.
   */
  test("[TC-PDMCP-103] hands over a config that names the variable rather than the secret", async ({ page }) => {
    await page.route(POLICY, (route) => route.fulfill({ json: { ceiling: "admin", enabled: true } }));
    await page.route(TOKENS, (route) => route.fulfill({ json: [] }));

    await ready(page, "/access");

    await expect(page.locator("[data-testid='mcp-token-endpoint']")).toContainText("/mcp");
    const config = page.locator("[data-testid='mcp-token-config']");
    await expect(config).toContainText("PDMUX_MCP_TOKEN");
    await expect(config).not.toContainText("PDMUX_MCP_KEY");
    await expect(await config.textContent()).not.toMatch(TOKEN_SHAPE);
    await expect(await page.locator("body").textContent()).not.toMatch(TOKEN_SHAPE);
  });
});
