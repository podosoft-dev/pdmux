import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";

/** Exercise the rendered desktop menu and the actual terminal relay. */
export async function verifyDesktopFirstRun(page, screenshot, { fresh = true } = {}) {
  const status = await page.evaluate(() => window.pdmuxDesktop.localAgent.status());
  assert.equal(status.phase,"ready","[TC-PDDESKTOP-017] embedded local agent is ready");
  let output = "";
  let input = "";
  let terminalReady = false;
  page.on("websocket", socket => {
    if (!socket.url().includes("/terminal/ws")) return;
    socket.on("framesent", ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.type === "input" && frame.termId === "slot-1") input += frame.data; } catch { /* Other transport frames are irrelevant. */ }
    });
    socket.on("framereceived", ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.type === "output" || frame.type === "screen") output += frame.data; if (frame.type === "ready" && frame.termId === "slot-1") terminalReady = true; } catch { /* Other transport frames are irrelevant. */ }
    });
  });
  if (fresh) {
    await page.reload();
    const names = [hostname()];
    if (process.platform === "darwin") {
      try { names.push(execFileSync("/usr/sbin/scutil",["--get","ComputerName"],{encoding:"utf8",timeout:2_000}).trim()); }
      catch { /* Without a friendly name only the hostname needs checking. */ }
    }
    const platformName = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Linux";
    const host = await page.evaluate(async id => (await fetch(`/api/hosts/${id}`)).json(),status.hostId);
    assert.match(host.label,new RegExp(`^${platformName} [0-9A-F]{4}( \\(\\d+\\))?$`),"[TC-PDDESKTOP-017] the default host names the platform and profile");
    for (const name of names.filter(Boolean)) assert.ok(!host.label.includes(name),"[TC-PDDESKTOP-017] the default host does not share the computer name");
    const card = page.locator(`[data-pdmux-host="${status.hostId}"]`);
    await card.waitFor();
    assert.ok((await card.textContent()).includes(host.label),"[TC-PDDESKTOP-017] the default host name appears in the host sidebar");
    const hostBounds = await card.boundingBox();
    assert.ok(hostBounds.width>150 && hostBounds.height>50,"[TC-PDDESKTOP-017] the named host card has a usable surface");
    assert.equal(await card.locator("[data-pdmux-name]").getAttribute("title"),host.label,"[TC-PDDESKTOP-017] the complete host name is available on hover");
    await page.screenshot({path:`${screenshot}.host.png`});
    await writeFile(`${screenshot}.host.json`,JSON.stringify({label:host.label,bounds:hostBounds},null,2));
    const pane = page.locator('[data-pdmux-pane="slot-1"]');
    await pane.waitFor({ timeout:30_000 });
    const area = pane.locator("textarea.xterm-helper-textarea");
    await area.waitFor({ state:"attached", timeout:30_000 });
    const readyDeadline = Date.now()+15_000;
    while ((!terminalReady || !output) && Date.now()<readyDeadline) await new Promise(resolve => setTimeout(resolve,50));
    assert.ok(terminalReady && output, "Wait for the terminal ready frame and initial shell output before typing");
    await page.bringToFront();
    await page.locator("html[data-hydrated=true]").waitFor();
    await pane.locator(".xterm-screen").click({ position: { x: 10, y: 10 } });
    await area.focus();
    assert.ok(await area.evaluate(node => document.activeElement === node), "Focus the actual terminal input");
    const platform = await page.evaluate(() => window.pdmuxDesktop.platform);
    const command = platform === "win32" ? "Write-Output ('PDMUX_DESKTOP_' + 'READY')" : "printf 'PDMUX_DESKTOP_%s\\n' READY";
    await page.keyboard.type(command, { delay: 20 });
    await page.keyboard.press("Enter");
    const inputDeadline = Date.now()+5_000;
    while ((!input.includes(command) || !input.endsWith("\r")) && Date.now()<inputDeadline) await new Promise(resolve => setTimeout(resolve,50));
    assert.ok(input.includes(command) && input.endsWith("\r"), "[TC-PDDESKTOP-017] terminal forwards the typed command and Enter");
    const deadline = Date.now()+15_000;
    while (!output.includes("PDMUX_DESKTOP_READY") && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,100));
    assert.ok(output.includes("PDMUX_DESKTOP_READY"),"[TC-PDDESKTOP-017] #1 accepts input and receives actual shell output");
    const bounds = await pane.boundingBox();
    assert.ok(bounds.width>200 && bounds.height>150,"Require a usable terminal surface");
  }
  // SSR markup can be visible before Svelte has attached the menu handlers.
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === "true");
  await page.locator('[data-testid="shell-user"]').click();
  const menu = page.locator('[data-testid="shell-user-menu"]');
  await menu.waitFor();
  for (const id of ["desktop-menu-settings","desktop-menu-updates"]) assert.equal(await menu.locator(`[data-testid="${id}"]`).count(),1,"[TC-PDDESKTOP-016] desktop menu action");
  for (const id of ["shell-user-admin","shell-user-account","shell-user-signout","shell-user-identity","nav-hosts","nav-settings","nav-access","shell-server-connection","desktop-menu-backup","desktop-menu-data"]) assert.equal(await menu.locator(`[data-testid="${id}"]`).count(),0,"[TC-PDDESKTOP-016] omit server account actions");
  const geometry = await menu.evaluate(node => {
    const box = node.getBoundingClientRect();
    return { x:box.x,y:box.y,width:box.width,height:box.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight };
  });
  assert.ok(geometry.width>=220 && geometry.height>100 && geometry.x>=0 && geometry.y>=0 && geometry.x+geometry.width<=geometry.viewportWidth+1 && geometry.y+geometry.height<=geometry.viewportHeight+1 && geometry.scrollHeight<=geometry.clientHeight+1,"[TC-PDDESKTOP-016] menu fits the window without clipping");
  await page.screenshot({path:screenshot}); await writeFile(`${screenshot}.json`,JSON.stringify({ status,geometry },null,2));
  await page.keyboard.press("Escape");
}
