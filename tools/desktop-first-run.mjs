import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

/** Exercise the rendered desktop menu and the actual terminal relay. */
export async function verifyDesktopFirstRun(page, screenshot, { fresh = true } = {}) {
  const status = await page.evaluate(() => window.pdmuxDesktop.localAgent.status());
  assert.equal(status.phase,"ready","[TC-PDDESKTOP-017] embedded local agent is ready");
  let output = "";
  page.on("websocket", socket => {
    if (!socket.url().includes("/terminal/ws")) return;
    socket.on("framereceived", ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.type === "output") output += frame.data; } catch { /* Other transport frames are irrelevant. */ }
    });
  });
  if (fresh) {
    await page.reload();
    const pane = page.locator('[data-pdmux-pane="slot-1"]');
    await pane.waitFor({ timeout:30_000 });
    const area = pane.locator("textarea.xterm-helper-textarea");
    await area.waitFor({ state:"attached", timeout:30_000 });
    await area.focus();
    const platform = await page.evaluate(() => window.pdmuxDesktop.platform);
    await page.keyboard.type(platform === "win32" ? "Write-Output ('PDMUX_DESKTOP_' + 'READY')" : "printf 'PDMUX_DESKTOP_%s\\n' READY");
    await page.keyboard.press("Enter");
    const deadline = Date.now()+15_000;
    while (!output.includes("PDMUX_DESKTOP_READY") && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,100));
    assert.ok(output.includes("PDMUX_DESKTOP_READY"),"[TC-PDDESKTOP-017] #1 accepts input and receives actual shell output");
    const bounds = await pane.boundingBox();
    assert.ok(bounds.width>200 && bounds.height>150,"Require a usable terminal surface");
  }
  await page.locator('[data-testid="shell-user"]').click();
  const menu = page.locator('[data-testid="shell-user-menu"]');
  await menu.waitFor();
  for (const id of ["desktop-menu-settings","shell-server-connection","desktop-menu-backup","desktop-menu-data","desktop-menu-updates"]) assert.equal(await menu.locator(`[data-testid="${id}"]`).count(),1,"[TC-PDDESKTOP-016] desktop menu action");
  for (const id of ["shell-user-admin","shell-user-account","shell-user-signout","shell-user-identity"]) assert.equal(await menu.locator(`[data-testid="${id}"]`).count(),0,"[TC-PDDESKTOP-016] omit server account actions");
  const geometry = await menu.evaluate(node => {
    const box = node.getBoundingClientRect();
    return { x:box.x,y:box.y,width:box.width,height:box.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight };
  });
  assert.ok(geometry.width>=220 && geometry.height>180 && geometry.x>=0 && geometry.y>=0 && geometry.x+geometry.width<=geometry.viewportWidth+1 && geometry.y+geometry.height<=geometry.viewportHeight+1 && geometry.scrollHeight<=geometry.clientHeight+1,"[TC-PDDESKTOP-016] menu fits the window without clipping");
  await page.screenshot({path:screenshot}); await writeFile(`${screenshot}.json`,JSON.stringify({ status,geometry },null,2));
  await page.keyboard.press("Escape");
}
