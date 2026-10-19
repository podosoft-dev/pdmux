import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import en from "../apps/web/src/lib/i18n/catalogs/app/en.json" with { type: "json" };
import ko from "../apps/web/src/lib/i18n/catalogs/app/ko.json" with { type: "json" };

/** [TC-PDDESKTOP-025] Measure controls and the font Chromium actually paints. */
export async function verifyTerminalFonts(page, directory, { terminal = false, loadFonts = false } = {}) {
  await mkdir(directory, { recursive: true });
  await page.getByTestId("shell-user").click();
  await page.getByTestId("shell-user-settings").click();
  await page.getByTestId("settings-tab-terminal").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="terminal-font"]').disabled);
  if (loadFonts) await page.getByTestId("terminal-fonts-load").click();
  await page.waitForFunction(messages => messages.includes(document.querySelector('[data-testid="terminal-fonts-status"]')?.textContent), [en.desktop.preferences.fontsLoaded, ko.desktop.preferences.fontsLoaded]);
  const controls = await page.getByTestId("terminal-settings-form").evaluate(node => {
    const rect = id => node.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().toJSON();
    return { font: rect("terminal-font"), size: rect("terminal-font-size"), theme: rect("terminal-theme"), lineHeight: rect("terminal-line-height"), viewport: { width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints } };
  });
  await page.screenshot({ path: join(directory, "controls.png"), scale: "css" });
  assert.equal(controls.font.height, controls.size.height, "Font controls have equal heights");
  if (controls.font.x !== controls.size.x) assert.ok(Math.abs(controls.font.y - controls.size.y) <= 1, "Font controls start on the same row");
  if (controls.theme.x !== controls.lineHeight.x) assert.ok(Math.abs(controls.theme.y - controls.lineHeight.y) <= 1, "Theme controls start on the same row");
  const original = await page.getByTestId("terminal-font").innerText();
  const custom = await page.getByTestId("terminal-custom-font").count() ? await page.getByTestId("terminal-custom-font").inputValue() : null;
  await page.getByTestId("terminal-font").click();
  assert.equal(await page.getByRole("option", { name: "Arial", exact: true }).count(), 0, "Proportional fonts are excluded");
  assert.equal(await page.getByRole("option", { name: "Apple Braille", exact: true }).count(), 0, "A font without Latin glyphs must not pass through a monospace fallback");
  await page.getByRole("option", { name: "D2Coding", exact: true }).waitFor({ timeout: 5_000 });
  await page.getByRole("option", { name: "D2Coding ligature", exact: true }).waitFor();
  await page.getByRole("option", { name: "D2Coding", exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  async function fonts(selector) {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
    assert.ok(nodeIds.length, `Font probe exists: ${selector}`);
    return (await Promise.all(nodeIds.slice(0, 80).map(async nodeId => (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts))).flat();
  }
  async function expectD2(selector) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const actual = await fonts(selector);
      if (actual.some(font => font.familyName === "D2Coding" && font.glyphCount > 0)) {
        assert.ok(actual.filter(font => font.familyName === "D2Coding").every(font => !font.isCustomFont), "D2Coding comes from the OS, not a bundled or downloaded web font");
        return actual;
      }
      await page.waitForTimeout(100);
    }
    assert.fail(`Expected painted D2Coding glyphs in ${selector}`);
  }
  const previewFonts = await expectD2('[data-testid="terminal-preview"]');
  await page.screenshot({ path: join(directory, "d2coding.png"), scale: "css" });
  let terminalFonts;
  try {
    await page.getByTestId("settings-save").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-save"]').disabled);
    await page.getByTestId("settings-close").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
    if (terminal) {
      await page.locator(".xterm-rows").first().waitFor();
      await page.screenshot({ path: join(directory, "terminal-d2coding.png"), scale: "css" });
      terminalFonts = await expectD2(".xterm-rows span");
    }
  } finally {
    // Restore preferences through the same UI; never write a user's profile file.
    if (!await page.getByTestId("settings-dialog").isVisible()) {
      await page.getByTestId("shell-user").click(); await page.getByTestId("shell-user-settings").click();
    }
    await page.getByTestId("settings-tab-terminal").click();
    await page.getByTestId("terminal-font").click();
    await page.getByRole("option", { name: original.trim(), exact: true }).click();
    if (custom !== null) await page.getByTestId("terminal-custom-font").fill(custom);
    await page.getByTestId("settings-ok").click();
    await cdp.detach();
  }
  const result = { result: "passed", controls, previewFonts, terminalFonts, preferencesRestored: true };
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
