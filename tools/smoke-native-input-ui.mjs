// [TC-PDTERM-021] [TC-PDTERM-022] [TC-PDTERM-130]
// Real native shell, fullscreen mouse owner and clipboard in disposable profiles.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, chromium } from "playwright";
import { verifyNativeMobileInput } from "./native-mobile-input.mjs";
import { fixtureNativeEngines, fixtureNativeSessions, stopFixtureNativeSessions } from "./native-session-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "pdmux-native-input-"));
const output = resolve(process.env.PDMUX_NATIVE_INPUT_OUTPUT ?? "output/playwright/native-input");
await mkdir(output, { recursive: true });
const profile = join(root, "profile");
let application; let browser; let page;
const measurements = [];
async function until(read, accepts, label) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const value = await read(); if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Native input condition failed: ${label}`);
}
function watch(page) {
  const state = { screen: null, sent: [], id: null, mouse: false };
  page.on("websocket", socket => {
    if (!new URL(socket.url()).pathname.endsWith("/terminal/ws")) return;
    socket.on("framesent", frame => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "open") { state.id = value.termId; state.screen = null; state.mouse = false; }
      if (value.termId === state.id) state.sent.push(value);
    });
    socket.on("framereceived", frame => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "screen" && value.termId === state.id) {
        state.screen = value;
        for(const mode of value.data.matchAll(/\x1b\[\?(9|1000|1002|1003)([hl])/g)) state.mouse = mode[2] === 'h';
      }
    });
  });
  return state;
}
async function text(page) { return page.locator('[data-pdmux-surface] .xterm-rows').first().innerText(); }
async function command(page, value) {
  await page.bringToFront();
  await page.locator('[data-pdmux-surface]').first().click();
  await page.keyboard.type(value); await page.keyboard.press("Enter");
}
async function shellReady(page) {
  await until(() => text(page), value => /[%$#>]\s*$/.test(value.trimEnd()), 'interactive shell prompt');
  await new Promise(resolve => setTimeout(resolve,150));
}
async function copyLabel(page, state, label, modifier) {
  await page.bringToFront();
  const row = page.locator('.xterm-rows > div').filter({ hasText: label }).first();
  const rowBox = await row.boundingBox();
  const screenBox = await page.locator('.xterm-screen').boundingBox();
  const rowText = await row.textContent();
  assert.ok(rowBox && screenBox && rowText);
  const column = rowText.indexOf(label), cell = screenBox.width / state.screen.cols;
  // Clear an earlier selection with the same force-selection gesture before
  // reselecting the identical range; xterm emits only settled range changes.
  if (modifier) await page.keyboard.down(modifier);
  try {
    await page.mouse.click(screenBox.x + screenBox.width - 3, rowBox.y + rowBox.height / 2);
    await application.evaluate(({ clipboard }) => clipboard.writeText('PDMUX_CLIPBOARD_BASELINE'));
    await page.mouse.move(screenBox.x + (column + .2) * cell, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(screenBox.x + (column + label.length + .2) * cell, rowBox.y + rowBox.height / 2, { steps: 15 });
    await page.mouse.up();
  } finally { if (modifier) await page.keyboard.up(modifier); }
  if (modifier) await page.keyboard.press('Meta+C');
  await until(() => application.evaluate(({ clipboard }) => clipboard.readText()), value => value.includes(label), `${modifier ?? 'plain'} drag copies ${label}`);
  assert.ok((await application.evaluate(({ clipboard }) => clipboard.readText())).includes(label));
}
async function pasteIntoTui(page, state, label) {
  await page.bringToFront();
  const pasted = `${label} 한글🙂\nsecond line`;
  await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), pasted);
  await page.evaluate(() => {
    window.pdmuxPasteProbe = [];
    document.addEventListener('paste', event => window.pdmuxPasteProbe.push({type:'paste', text:event.clipboardData?.getData('text/plain')}), {once:true,capture:true});
  });
  const start = state.sent.length;
  await page.locator('[data-pdmux-surface]').click();
  await page.keyboard.press('Meta+V');
  await new Promise(resolve => setTimeout(resolve, 200));
  await writeFile(join(output, `${label.toLowerCase()}-wire.json`), JSON.stringify({frames:state.sent.slice(start),events:await page.evaluate(()=>window.pdmuxPasteProbe),clipboard:await application.evaluate(({clipboard})=>clipboard.readText())}, null, 2));
  await until(() => state.sent.slice(start).filter(frame => frame.type === 'input').map(frame => frame.data).join(''), value => value.includes(pasted.replaceAll('\n','\r')), `${label} exact Unicode multiline paste input`);
  // No Enter: validating paste must never submit a prompt to a coding service.
  await until(() => text(page), value => value.includes(label), `${label} displays pasted prompt`);
}
async function shot(page, stage) {
  const geometry = await page.locator('[data-pdmux-surface]').first().evaluate(element => ({ box: element.getBoundingClientRect().toJSON(), screen: element.querySelector('.xterm-screen')?.getBoundingClientRect().toJSON(), dpr: devicePixelRatio }));
  assert.ok(geometry.box.width > 200 && geometry.box.height > 100);
  assert.ok(geometry.screen.width <= geometry.box.width + 1 && geometry.screen.height <= geometry.box.height + 1);
  measurements.push({ stage, ...geometry });
  await page.screenshot({ path: join(output, `${stage}.png`) });
  console.log(JSON.stringify({stage}));
}
try {
  application = await electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${profile}`], env: { ...process.env, PDMUX_DESKTOP_AGENT_RELEASE_DIR: process.env.PDMUX_DESKTOP_AGENT_RELEASE_DIR ?? resolve("apps/web/static/agent"), TMUX: "", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", TERM_PROGRAM: "WarpTerminal" }, timeout: 60_000 });
  page = await application.firstWindow({ timeout: 60_000 });
  const desktop = watch(page);
  await page.locator('[data-pdmux-surface] .xterm-rows').waitFor({ timeout: 45_000 });
  await page.reload();
  await until(() => desktop.screen, Boolean, "desktop screen ready");
  const engines = await fixtureNativeEngines(profile);
  assert.equal(engines.length, 1);
  const engine = engines[0];
  const info = await until(() => fixtureNativeSessions(engine)[0], value => value?.attached === 1, "default native shell");
  const originalPid = info.pid;
  await command(page, `printf 'CAPS=%s/%s/%s/%s\\n' "$TERM" "$COLORTERM" "$TERM_PROGRAM" "\${NO_COLOR-unset}"; printf '\\033[31mRED \\033[38;5;202mINDEX \\033[38;2;12;134;56mTRUECOLOR\\033[0m\\n'`);
  await until(() => text(page), value => value.includes("CAPS=xterm-256color/truecolor/PDMux/unset"), "desktop color environment");
  const colors = await page.locator('.xterm-rows span').evaluateAll(elements => elements.filter(element => /^(RED|INDEX|TRUECOLOR)/.test(element.textContent ?? '')).map(element => ({ text: element.textContent, color: getComputedStyle(element).color })));
  assert.equal(new Set(colors.map(value => value.color)).size, 3);
  await shot(page, "desktop-colors");
  await command(page, "printf 'UNICODE_WIDTH:\\033[41m\\360\\237\\231\\202\\033[42mX\\033[0m\\n'");
  await until(()=>text(page),value=>value.includes('UNICODE_WIDTH:🙂X'),'native Unicode width probe');
  const unicodeGeometry=await page.locator('.xterm-rows > div').filter({hasText:'UNICODE_WIDTH:🙂X'}).last().evaluate(row=>Array.from(row.querySelectorAll('span')).map(span=>({text:span.textContent,box:span.getBoundingClientRect().toJSON()})));
  const emoji=unicodeGeometry.find(span=>span.text==='🙂'), next=unicodeGeometry.find(span=>span.text==='X');
  const screenBox=await page.locator('.xterm-screen').first().boundingBox();
  assert.ok(emoji&&next&&screenBox);
  const cellWidth=screenBox.width/desktop.screen.cols;
  await writeFile(join(output,'unicode-width.json'),JSON.stringify({unicodeGeometry,cellWidth},null,2));
  assert.ok(Math.abs(next.box.x-emoji.box.x-2*cellWidth)<1,'emoji and following text must occupy their native engine columns');
  await shot(page,'desktop-unicode-width');
  await command(page, `for i in $(seq 1 180); do printf 'NATIVE_ROW_%03d\\n' "$i"; done`);
  await until(() => text(page), value => value.includes("NATIVE_ROW_180"), "long shell output");
  const terminal = page.locator('[data-pdmux-surface]').first();
  await terminal.hover();
  const before = desktop.sent.length;
  await page.mouse.wheel(0, -200);
  await until(() => desktop.screen?.history, value => value > 0, "ordinary wheel reaches native history");
  assert.equal(desktop.sent.slice(before).filter(frame => frame.type === 'input' && /\x1b(?:\[|O)[AB]/.test(frame.data)).length, 0);
  const historyText = await text(page);
  assert.ok(!historyText.includes("NATIVE_ROW_180"));
  await shot(page, "desktop-shell-history");
  await page.mouse.wheel(0, 4000);
  await until(() => desktop.screen?.history, value => value === 0, "wheel returns to live shell");

  // Paste through Electron's real clipboard and xterm's DOM paste handler.
  const clipboardBefore = await application.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const pasted = "alpha 한글\nbeta🙂";
    await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), pasted);
    const receiver = join(root, 'paste.py');
    await writeFile(receiver, `import os,sys,termios,tty,base64\nold=termios.tcgetattr(0); tty.setraw(0)\ntry:\n sys.stdout.write('\\x1b[?2004hPASTE_READY'); sys.stdout.flush()\n data=b''\n while b'\\x1b[201~' not in data: data+=os.read(0,4096)\n payload=data.split(b'\\x1b[200~',1)[1].split(b'\\x1b[201~',1)[0]\n sys.stdout.write('\\r\\nWIRE_'+base64.b64encode(payload).decode()+'\\r\\nPASTE_OK='+payload.decode().replace('\\r','|')+'\\r\\n'); sys.stdout.flush()\nfinally:\n sys.stdout.write('\\x1b[?2004l'); sys.stdout.flush(); termios.tcsetattr(0,termios.TCSADRAIN,old)\n`);
    await command(page, `python3 '${receiver}'`);
    await until(() => text(page), value => value.includes('PASTE_READY'), 'raw paste receiver ready');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+Shift+V');
    const expected = Buffer.from(pasted.replaceAll('\n','\r')).toString('base64');
    await until(() => text(page), value => value.replaceAll(/\s/g,'').includes('WIRE_'+expected), 'exact Unicode multiline paste bytes');
    await until(() => text(page), value => value.includes("PASTE_OK=alpha 한글|beta🙂"), "multiline Unicode paste");
    const screen = terminal.locator('.xterm-screen');
    const box = await screen.boundingBox(); assert.ok(box);
    const row = await page.locator('.xterm-rows > div').filter({ hasText: 'PASTE_OK=alpha 한글|beta🙂' }).last().boundingBox(); assert.ok(row);
    await page.mouse.move(box.x + 1, row.y + row.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + Math.min(300, box.width - 2), row.y + row.height / 2, { steps: 12 }); await page.mouse.up();
    await until(() => application.evaluate(({ clipboard }) => clipboard.readText()), value => value.includes("PASTE_OK=alpha 한글|beta🙂"), "selection copies Unicode text");
    await shot(page, 'desktop-copy-paste');
  } finally { await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardBefore); }

  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(await page.context().cookies());
  const web = await context.newPage(); const wide = watch(web);
  const hosts = await page.evaluate(async () => (await fetch('/api/hosts')).json());
  const localStatus = await page.evaluate(() => window.pdmuxDesktop.localAgent.status());
  const host = hosts.find(host => host.id === localStatus.hostId); assert.ok(host);
  await web.goto(`${new URL(page.url()).origin}/terminal?host=${host.id}&kind=attach&session=${info.name}&backend=native&sessionId=${info.id}`);
  await until(() => wide.screen, Boolean, "large browser shares the same native shell");
  const canonical = () => fixtureNativeSessions(engine).find(item => item.id === info.id);
  await until(canonical, value => value.attached === 2 && value.cols === Math.max(wide.screen.cols, desktop.screen.cols) && value.rows === Math.max(wide.screen.rows, desktop.screen.rows), "largest shared geometry");
  await command(web, "printf 'SAME_PID=%s\\n' $$");
  await until(() => text(web), value => value.includes(`SAME_PID=${originalPid}`), "same PTY in browser");
  await shot(web, "browser-shared-large");
  await shot(page, "desktop-shared-small");

  // A local deterministic fullscreen program exercises Claude Code's mouse,
  // bracketed-paste and redraw protocol without creating a paid conversation.
  const fixture = join(root, 'mouse.py');
  await writeFile(fixture, `import os,sys,termios,tty,re\nfd=0; old=termios.tcgetattr(fd); tty.setraw(fd)\nposition=100\ndef draw():\n sys.stdout.write('\\x1b[2J\\x1b[H\\x1b[36mFULLSCREEN_ROW_%03d\\x1b[0m\\r\\nSHIFT_SELECT_COPY' % position); sys.stdout.flush()\ntry:\n sys.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[?2004h'); draw()\n while True:\n  data=os.read(fd,4096)\n  if b'q' in data: break\n  for event in re.findall(rb'\\x1b\\[<(64|65);[0-9]+;[0-9]+M',data):\n   position += -1 if event == b'64' else 1\n  draw()\nfinally:\n sys.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?2004l\\x1b[?1049l'); sys.stdout.flush(); termios.tcsetattr(fd,termios.TCSADRAIN,old)\n`);
  await command(web, `python3 '${fixture}'`);
  await until(() => text(web), value => value.includes('FULLSCREEN_ROW_100'), 'fullscreen application');
  await terminal.hover(); const wheelStart = desktop.sent.length;
  await page.mouse.wheel(0, -100);
  await until(() => text(web), value => /FULLSCREEN_ROW_09[0-9]/.test(value), 'small viewer wheel reaches fullscreen owner');
  assert.ok(desktop.sent.slice(wheelStart).some(frame => frame.type === 'input' && frame.source === 'wheel' && /\x1b\[<64;/.test(frame.data)));
  assert.equal(desktop.screen.alternate, true);
  assert.equal(desktop.screen.history, 0);
    // Force selection over a program that owns the mouse, then copy via Cmd/Ctrl.
  const fullBox = await web.locator('.xterm-screen').boundingBox();
  const selectRow = await web.locator('.xterm-rows > div').filter({ hasText: 'SHIFT_SELECT_COPY' }).last().boundingBox();
  assert.ok(fullBox && selectRow);
  const oldClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await web.keyboard.down('Shift');
    await web.mouse.move(fullBox.x + 1, selectRow.y + selectRow.height / 2); await web.mouse.down();
    await web.mouse.move(fullBox.x + 18 * fullBox.width / wide.screen.cols, selectRow.y + selectRow.height / 2, { steps: 12 });
    await web.mouse.up(); await web.keyboard.up('Shift');
    // Browser clipboard permissions are explicit and scoped to the fixture origin.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await web.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+Shift+C');
    await until(() => web.evaluate(() => navigator.clipboard.readText()), value => value.includes('SHIFT_SELECT_COPY'), 'forced TUI selection copies');
  } finally { await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), oldClipboard); }
  await shot(page, 'desktop-fullscreen-wheel');
  await shot(web, 'browser-fullscreen-wheel');
  await web.locator('[data-pdmux-surface]').click(); await web.keyboard.type('q');
  await until(() => wide.screen?.alternate, value => value === false, 'fullscreen exits to shell');
  assert.equal(canonical().pid, originalPid);
  if (process.env.PDMUX_NATIVE_INPUT_CLAUDE === '1') {
    await command(web, `cd '${resolve('..')}'; claude --settings '{"tui":"fullscreen"}'`);
    await until(() => text(web), value => /Claude Code|trust this folder/.test(value), 'real Claude Code starts');
    if ((await text(web)).includes('trust this folder')) { await web.keyboard.press('Enter'); }
    await until(() => wide.screen?.alternate, Boolean, 'real Claude Code fullscreen');
    await command(web, '/config');
    await until(() => text(web), value => /Settings|Settings:|Config/.test(value), 'Claude config list');
    await new Promise(resolve => setTimeout(resolve, 500));
    const initialClaude = await web.locator('.xterm-rows > div').allTextContents();
    await shot(web, 'browser-claude-before-scroll');
    const claudeInputs = wide.sent.length;
    await web.locator('[data-pdmux-surface]').hover();
    for (let i = 0; i < 8; i++) { await web.mouse.wheel(0, 100); await new Promise(resolve => setTimeout(resolve, 100)); }
    const afterClaude = await web.locator('.xterm-rows > div').allTextContents();
    await writeFile(join(output, 'claude-wheel.json'), JSON.stringify({ before: initialClaude, after: afterClaude, inputs: wide.sent.slice(claudeInputs).filter(value => value.type === 'input'), screenModes: wide.screen.data.match(/\x1b\[\?[0-9;]+[hl]/g) }, null, 2));
    assert.notDeepEqual(afterClaude.slice(6), initialClaude.slice(6), 'Claude config wheel must change settings rows, not only its status line');

    await web.keyboard.press('Escape');
    const clipboardSaved = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      for (const modifier of [undefined, 'Shift', 'Alt']) await copyLabel(web, wide, 'Claude Code', modifier);
      await pasteIntoTui(web, wide, 'CLAUDE_PASTE');
      await shot(web, 'browser-claude-copy-paste');
      await web.keyboard.press('Control+C');
      await new Promise(resolve => setTimeout(resolve, 600));
    } finally { await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardSaved); }
    await shot(web, 'browser-claude-scroll');
    await shot(page, 'desktop-claude-scroll');
    await web.keyboard.press('Escape');
    await command(web, '/exit');
    await until(() => wide.screen?.alternate, value => value === false, 'Claude restores shell');
    await shellReady(web);
    await shot(web, 'browser-after-claude');
  }
  if (process.env.PDMUX_NATIVE_INPUT_MOBILE === '1') {
    await verifyNativeMobileInput({ application, browser, origin: new URL(page.url()).origin, cookies: await page.context().cookies(), hostId:host.id, root, output:join(output,'mobile'), watch, command, text, until });
  }
  await web.close();
  await until(canonical, value => value.attached === 1 && value.cols === desktop.screen.cols && value.rows === desktop.screen.rows, 'remaining viewer owns PTY size');
  if (process.env.PDMUX_NATIVE_INPUT_CODEX === '1') {
    const codexWork = join(root, 'codex-work'); await mkdir(codexWork);
    await page.goto(`${new URL(page.url()).origin}/terminal?host=${host.id}&kind=new&session=codex-check&backend=native`);
    await until(() => desktop.screen, Boolean, 'fresh Codex shell');
    await shellReady(page);
    await command(page, `cd '${codexWork}'; command codex --sandbox read-only; printf 'CODEX_EXIT_%s\\n' "$?"`);
    await until(() => text(page), value => /OpenAI Codex|Codex.*0\.163|CODEX_EXIT_[0-9]/i.test(value), 'real Codex starts');
    await writeFile(join(output, 'codex-start.json'), JSON.stringify({ text: await text(page), alternate: desktop.screen?.alternate }));
    assert.ok(!(await text(page)).match(/CODEX_EXIT_[0-9]/), 'Codex exited before displaying its UI');
    await shot(page, 'desktop-codex');
    const saved = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      // Codex owns plain mouse events. Its documented terminal selection path
      // is the force-selection modifier, rather than application-owned dragging.
      for (const modifier of ['Shift', 'Alt']) await copyLabel(page, desktop, 'OpenAI Codex', modifier);
      await pasteIntoTui(page, desktop, 'CODEX_PASTE');
      await shot(page, 'desktop-codex-copy-paste');
      await page.keyboard.press('Control+C');
      await new Promise(resolve => setTimeout(resolve, 600));
    } finally { await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), saved); }
    await terminal.hover();
    for (let i=0; i<8; i++) { await page.mouse.wheel(0, 100); await new Promise(resolve => setTimeout(resolve, 40)); }
    await page.keyboard.press('Control+D');
    await until(() => desktop.screen?.alternate, value => value === false, 'Codex restores shell');
    await shellReady(page);
    const afterExit = desktop.sent.length;
    await page.mouse.wheel(0, 100); await page.mouse.wheel(0, -100);
    await command(page, "printf '%s%s\\n' 'AFTER_CODEX_' 'OK'");
    await until(() => text(page), value => value.includes('AFTER_CODEX_OK'), 'shell accepts normal input after Codex');
    assert.ok(!desktop.sent.slice(afterExit).some(frame => frame.type === 'input' && frame.source === 'wheel' && /\x1b(?:\[|O)[AB]/.test(frame.data)), 'post-exit wheel must not type arrows');
    assert.ok(!(await text(page)).includes('^[[B') && !(await text(page)).includes('^[[I'), 'shell contains no leaked protocol reports');
    await shot(page, 'desktop-after-codex');
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ result: 'passed', platform: process.platform, desktop: 'Electron headed', browser: 'Google Chrome headed', colors, samePid: originalPid, shellWheel: true, fullscreenWheel: true, unicodeCopyPaste: true, forcedTuiCopy: true, claudeConfigWheel: process.env.PDMUX_NATIVE_INPUT_CLAUDE === '1', measurements }, null, 2));
  console.log(JSON.stringify({ stage: 'native-input-ui', result: 'passed' }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stopFixtureNativeSessions(root);
  await application?.close();
  await rm(root, { recursive: true, force: true });
}
