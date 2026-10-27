import { devices, type Locator } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/pdmux-test";
import { hydrated, ready } from "../helpers/hydration";
import { readLayout, writeLayout } from "../helpers/pdmux-layout";
import { parseAgentVersion } from "../../apps/desktop/src/staging";

// Manual verification can reuse an explicitly supplied disposable account without
// running the shared account setup or revoking any existing browser sessions.
if (process.env.PDMUX_PRESENTATION_STORAGE_STATE) test.use({ e2eState: process.env.PDMUX_PRESENTATION_STORAGE_STATE });

test("[TC-PDUI-237] [TC-PDUI-236] [TC-PDTERM-022] personal names and colored tags preserve a native session across editing, reload and detach", async ({ page, request, context, browser }) => {
  test.setTimeout(90_000);
  const repository = resolve(__dirname, "../..");
  const version = parseAgentVersion(await readFile(join(repository, "agent/internal/cli/version.go"), "utf8"));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const binary = process.env.PDMUX_PRESENTATION_AGENT_BINARY ?? join(repository, `apps/web/static/agent/${version}/pdmux-agent-${platform}-${arch}${process.platform === "win32" ? ".exe" : ""}`);
  test.skip(!existsSync(binary), "Build the current platform's agent to test a real native PTY");
  const saved = await readLayout(request);
  const directory = await mkdtemp(join(tmpdir(), "pdmux-presentation-"));
  const config = join(directory, "agent.json");
  const nativeRoot = join(directory, "state/sessions", createHash("sha256").update(config).digest("hex").slice(0, 24));
  const tmuxEnvironment = { ...process.env, TMUX: "", TMUX_TMPDIR: directory };
  const tmuxSocket = join(directory, `tmux-${process.getuid?.() ?? 0}/default`);
  let legacy: { id: string; pid: number } | null = null;
  function tmux(...args: string[]): string { return execFileSync("tmux", ["-S", tmuxSocket, ...args], { env: tmuxEnvironment, encoding: "utf8", windowsHide: true }).trim(); }
  let hostId = "";
  let fixtureHostName = "";
  let child: ReturnType<typeof spawn> | undefined;
  interface Session { id: string; pid: number; name: string; }
  function sessions(): Session[] {
    return JSON.parse(execFileSync(binary, ["session", "list", "--root", nativeRoot, "--json"], { encoding: "utf8", windowsHide: true }));
  }
  async function geometry(pane: Locator) {
    const result = await pane.evaluate(element => {
      const rect = (selector: string) => element.querySelector(selector)?.getBoundingClientRect().toJSON();
      return { pane: element.getBoundingClientRect().toJSON(), header: rect(".pdmux-pane-head"), caption: rect(".pdmux-pane-caption"), actions: rect(".pdmux-pane-acts"), surface: rect("[data-pdmux-surface]"), viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth };
    });
    expect(result.caption!.width).toBeGreaterThan(45);
    expect(result.caption!.right).toBeLessThanOrEqual(result.actions!.x + 1);
    expect(result.surface!.height).toBeGreaterThan(70);
    expect(result.surface!.width).toBeGreaterThan(100);
    expect(result.documentWidth).toBeLessThanOrEqual(result.viewport.width + 1);
    return result;
  }
  const editors: unknown[] = [];
  async function editorGeometry(dialog: Locator): Promise<void> {
    const result = await dialog.evaluate(element => ({
      dialog: element.getBoundingClientRect().toJSON(),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      controls: [...element.querySelectorAll("input, button")].map(control => ({
        name: control.getAttribute("id") ?? control.getAttribute("aria-label") ?? control.textContent,
        ...control.getBoundingClientRect().toJSON(),
      })), viewport: { width: innerWidth, height: innerHeight },
    }));
    expect(result.dialog.x).toBeGreaterThanOrEqual(0);
    expect(result.dialog.right).toBeLessThanOrEqual(result.viewport.width + 1);
    expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth + 1);
    expect(result.scrollHeight).toBeLessThanOrEqual(result.clientHeight + 1);
    for (const control of result.controls) {
      expect(control.width).toBeGreaterThan(20);
      expect(control.x).toBeGreaterThanOrEqual(result.dialog.x);
      expect(control.right).toBeLessThanOrEqual(result.dialog.right);
    }
    const background = result.controls.find(control => control.name === "terminal-tag-background-0")!;
    const foreground = result.controls.find(control => control.name === "terminal-tag-text-0")!;
    expect(background.right).toBeLessThanOrEqual(foreground.x);
    expect(background.y).toBe(foreground.y);
    editors.push(result);
  }
  try {
    if (process.platform !== "win32") {
      try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { test.skip(true, "tmux is required to verify legacy session management"); }
      await mkdir(join(directory, `tmux-${process.getuid?.() ?? 0}`), { mode: 0o700 });
      tmux("-f", "/dev/null", "new-session", "-d", "-s", "legacy-one", "exec /bin/sh");
      tmux("new-session", "-d", "-s", "legacy-unused", "exec /bin/sh");
      const [id, pid] = tmux("display-message", "-p", "-t", "=legacy-one:", "#{session_id}|#{pane_pid}").split("|");
      expect(id).toMatch(/^\$[0-9]+$/); expect(Number(pid)).toBeGreaterThan(0);
      legacy = { id: id!, pid: Number(pid) };
    }
    const created = await request.post("/api/hosts", { data: { label: `presentation-${Date.now()}` } });
    expect(created.ok(), `Create the disposable host: ${await created.text()}`).toBe(true);
    const createdHost = await created.json() as { id: string; label: string };
    hostId = createdHost.id; fixtureHostName = createdHost.label;
    const minted = await request.post(`/api/hosts/${hostId}/tokens`, { data: { name: "presentation-test" } });
    expect(minted.ok()).toBe(true);
    const { token } = await minted.json() as { token: string };
    await writeFile(config, JSON.stringify({ server: process.env.PDMUX_PRESENTATION_AGENT_ORIGIN ?? test.info().project.use.baseURL, token, hostname: "presentation-fixture", logLevel: "error" }), { mode: 0o600 });
    child = spawn(binary, ["run"], { env: { ...tmuxEnvironment, PDMUX_CONFIG: config, PDMUX_STATE_DIR: join(directory, "state") }, stdio: "ignore", windowsHide: true });
    await expect.poll(async () => ((await (await request.get(`/api/hosts/${hostId}`)).json()) as { connected: boolean }).connected).toBe(true);
    const slot = { id: "presentation-pane", hostId, kind: "new", session: "presentation-test", backend: "native", intent: "create" };
    const seeded = { name: saved?.name ?? "default", payload: { mode: "tab", slots: [slot], focusId: slot.id, sidebarOpen: false, dockOpen: false, filesOpen: false }, isDefault: true };
    await writeLayout(request, seeded);
    let opens = 0;
    page.on("websocket", socket => socket.on("framesent", frame => {
      const value = JSON.parse(String(frame.payload)) as { type: string };
      if (value.type === "open") opens++;
    }));
    await ready(page, "/");
    const pane = page.locator(`[data-pdmux-pane="${slot.id}"]`);
    await expect.poll(() => sessions().length).toBe(1);
    const original = sessions()[0]!;
    await expect.poll(() => opens).toBeGreaterThan(0);
    await expect.poll(async () => (await readLayout(request))?.payload.slots).toMatchObject([{ sessionId: original.id }]);
    const before = await geometry(pane);
    await page.screenshot({ path: test.info().outputPath("before.png") });
    const surface = pane.locator("[data-pdmux-surface]");
    if (process.platform !== "win32") {
      // A real raw-mode TUI changes its Unicode window title after every key,
      // as coding clients do. Its OSC bytes must never become editable text.
      const script = String.raw`import os,sys,termios,tty
old=termios.tcgetattr(0);tty.setraw(0);draft="DRAFT:"
def paint():
 sys.stdout.write("\x1b[H\x1b[2K"+draft+"\x1b]0;\u25d1 \uc911\ub2e8\ub41c \uc791\uc5c5 \ubcd1\ub82c \uc7ac\uac1c\x07");sys.stdout.flush()
try:
 sys.stdout.write("\x1b[2J");paint()
 while True:
  data=os.read(0,1)
  if data==b"\x04":break
  draft=draft[:-1] if data==b"\x7f" else draft+data.decode();paint()
finally:
 termios.tcsetattr(0,termios.TCSADRAIN,old);sys.stdout.write("\r\n");sys.stdout.flush()
`;
      const encoded = Buffer.from(script).toString("base64");
      const command = `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`;
      await surface.click();
      await page.keyboard.insertText(command); await page.keyboard.press("Enter");
      const firstRow = surface.locator(".xterm-rows > div").first();
      await expect.poll(async () => (await firstRow.innerText()).trim()).toBe("DRAFT:");
      await page.keyboard.type("abc");
      await expect.poll(async () => (await firstRow.innerText()).trim()).toBe("DRAFT:abc");
      await page.keyboard.press("Backspace");
      await expect.poll(async () => (await firstRow.innerText()).trim()).toBe("DRAFT:ab");
      expect(opens).toBeGreaterThan(0);
      expect(sessions()[0]!.pid).toBe(original.pid);
      await page.screenshot({ path: test.info().outputPath("unicode-title-typing.png") });
      await page.keyboard.press("Control+d");
    }
    await surface.evaluate(element => element.setAttribute("data-presentation-probe", "same-surface"));
    const count = opens;
    await pane.locator("[data-pdmux-pane-more]").click();
    await page.locator("[data-pdmux-edit-presentation]").click();
    const dialog = page.getByTestId("terminal-presentation-dialog");
    await dialog.locator("#terminal-display-name").fill("\uacb0\uc81c API \uc791\uc5c5");
    await dialog.getByTestId("terminal-tag-add").click();
    await dialog.getByRole("textbox", { name: "Tag name" }).fill("\uc6b4\uc601");
    await dialog.getByLabel("Background", { exact: true }).fill("#e11d48");
    await expect(dialog.getByTestId("terminal-tag-text-auto")).toBeDisabled();
    await dialog.getByLabel("Text color", { exact: true }).fill("#fde047");
    await expect(dialog.getByTestId("terminal-tag-text-auto")).toBeEnabled();
    await editorGeometry(dialog);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath("editor.png") });
    await dialog.getByTestId("terminal-presentation-save").click();
    await expect(pane.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
    await expect(pane.locator(".pdmux-pane-tag")).toHaveText("\uc6b4\uc601");
    await expect(pane.locator(".pdmux-pane-tag")).toHaveCSS("background-color", "rgb(225, 29, 72)");
    await expect(pane.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(253, 224, 71)");
    await expect(surface).toHaveAttribute("data-presentation-probe", "same-surface");
    expect(opens).toBe(count);
    expect(sessions()[0]!.pid).toBe(original.pid);
    const after = await geometry(pane);
    await expect.poll(async () => (await readLayout(request))?.payload.slots).toMatchObject([{ label: "\uacb0\uc81c API \uc791\uc5c5", tags: [{ name: "\uc6b4\uc601", color: "#e11d48", textColor: "#fde047" }], sessionId: original.id }]);
    await page.screenshot({ path: test.info().outputPath("saved.png") });
    // A second window must learn the name through the host's UUID, not this layout.
    const observer = await context.newPage();
    try {
      await ready(observer, test.info().project.use.baseURL as string);
      await expect(observer.locator(".pdmux-pane-caption")).toContainText("presentation-test");
      const renameCount = opens;
      await pane.locator("[data-pdmux-pane-more]").click();
      await page.locator("[data-pdmux-rename-session]").click();
      const rename = page.getByTestId("session-rename-dialog");
      await rename.locator("#terminal-session-name").fill("bad name");
      await expect(rename.getByTestId("session-rename-save")).toBeDisabled();
      await rename.locator("#terminal-session-name").fill("api-work");
      const box = await rename.boundingBox();
      expect(box!.width).toBeGreaterThan(250);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      const controls = await rename.evaluate(element => {
        const input = element.querySelector("input")!.getBoundingClientRect();
        const save = element.querySelector("[data-testid=session-rename-save]")!.getBoundingClientRect();
        return { input: input.toJSON(), save: save.toJSON(), height: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      expect(controls.input.bottom).toBeLessThan(controls.save.y);
      expect(controls.scrollHeight).toBeLessThanOrEqual(controls.height + 1);
      await page.screenshot({ path: test.info().outputPath("session-rename-editor.png") });
      await rename.getByTestId("session-rename-save").click();
      await expect(rename).not.toBeVisible();
      await expect(pane.locator(".pdmux-pane-caption")).toContainText("api-work");
      await expect(observer.locator(".pdmux-pane-caption")).toContainText("api-work", { timeout: 15_000 });
      expect(opens).toBe(renameCount);
      expect(sessions()).toMatchObject([{ id: original.id, pid: original.pid, name: "api-work" }]);
      await expect(surface).toHaveAttribute("data-presentation-probe", "same-surface");
      await geometry(pane);
      await page.screenshot({ path: test.info().outputPath("session-renamed.png") });
    } finally { await observer.close(); }

    await page.reload();
    await hydrated(page);
    await expect(pane.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
    await expect(pane.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(253, 224, 71)");
    expect(sessions()[0]!.pid).toBe(original.pid);
    await page.bringToFront();
    await pane.locator("[data-pdmux-pane-more]").click();
    const popupPromise = context.waitForEvent("page", { timeout: 15_000 });
    await page.locator("[data-pdmux-detach]").press("Enter");
    const popup = await popupPromise;
    try {
      // The detached window's markup is server-rendered, so the checks below pass before
      // it hydrates, and a click on the pane menu before hydration opens nothing. On a
      // fresh dev server the /terminal route compiles on this first visit, which is what
      // made the menu click land early every time.
      await hydrated(popup);
      await expect(popup.locator(".pdmux-pane-tag")).toHaveText("\uc6b4\uc601");
      await expect(popup.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(253, 224, 71)");
      await expect(popup).toHaveTitle("\uacb0\uc81c API \uc791\uc5c5 · PDMux");
      await expect(popup.locator(".pdmux-pane-caption")).toContainText("api-work");
      await popup.locator("[data-pdmux-pane-more]").click();
      await popup.locator("[data-pdmux-rename-session]").click();
      await popup.locator("#terminal-session-name").fill("detached-work");
      await popup.getByTestId("session-rename-save").click();
      await expect(popup.getByTestId("session-rename-dialog")).not.toBeVisible();
      await expect(pane.locator(".pdmux-pane-caption")).toContainText("detached-work", { timeout: 15_000 });
      await popup.reload();
      await expect(popup.locator(".pdmux-pane-caption")).toContainText("detached-work");
      await expect(popup.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
      expect(sessions()[0]!.pid).toBe(original.pid);
    } finally { await popup.close(); }
    await pane.locator("[data-pdmux-pane-more]").click();
    await page.locator("[data-pdmux-manage-sessions]").click();
    const manager = page.getByTestId("session-manager-dialog");
    await manager.getByRole("textbox", { name: "Host or session", exact: true }).fill(fixtureHostName);
    await manager.getByRole("button", { name: "Search", exact: true }).click();
    if (legacy) {
      const legacyWindow = await context.newPage();
      try {
        await legacyWindow.goto(`/terminal?${new URLSearchParams({ host: hostId, kind: "attach", backend: "tmux", tmuxId: legacy.id, session: "legacy-one" })}`, { waitUntil: "domcontentloaded", timeout: 10_000 });
        await expect(legacyWindow.locator(".pdmux-pane-caption")).toContainText("legacy-one");
        await page.bringToFront();
        await manager.locator(`[data-host-id="${hostId}"][data-session-id="${legacy.id}"]`).click({ timeout: 5_000 });
        await manager.getByTestId("session-manager-rename").click({ timeout: 5_000 });
        await page.locator("#terminal-session-name").fill("legacy-renamed");
        await page.getByTestId("session-rename-save").click();
        await expect(page.getByTestId("session-rename-dialog")).not.toBeVisible();
        await expect(legacyWindow.locator(".pdmux-pane-caption")).toContainText("legacy-renamed", { timeout: 15_000 });
        expect(Number(tmux("display-message", "-p", "-t", `${legacy.id}:`, "#{pane_pid}"))).toBe(legacy.pid);
        await legacyWindow.reload();
        await expect(legacyWindow.locator(".pdmux-pane-caption")).toContainText("legacy-renamed");
        expect(tmux("list-sessions", "-F", "#{session_name}").split("\n").sort()).toEqual(["legacy-renamed", "legacy-unused"]);
      } finally { await legacyWindow.close(); }
      const unusedId = tmux("display-message", "-p", "-t", "=legacy-unused:", "#{session_id}");
      const unusedRow = manager.locator(`[data-host-id="${hostId}"][data-session-id="${unusedId}"]`);
      await unusedRow.click();
      await manager.getByTestId("session-manager-terminate").click();
      const confirmation = page.getByTestId("session-terminate-confirm");
      await expect(confirmation.getByTestId("session-terminate-target")).toContainText("legacy-unused");
      await page.screenshot({ path: test.info().outputPath("tmux-terminate-confirm.png") });
      await confirmation.getByTestId("session-terminate-confirm-confirm").click();
      await expect(confirmation).not.toBeVisible();
      await expect.poll(() => tmux("list-sessions", "-F", "#{session_name}")).toBe("legacy-renamed");
      expect(Number(tmux("display-message", "-p", "-t", `${legacy.id}:`, "#{pane_pid}"))).toBe(legacy.pid);
    }

    await manager.locator(`[data-session-id="${original.id}"]`).click();
    await expect(manager.getByTestId("session-manager-rename")).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("session-manager-desktop.png") });
    await manager.getByTestId("session-manager-rename").click();
    await page.locator("#terminal-session-name").fill("manager-work");
    await page.getByTestId("session-rename-save").click();
    await expect(page.getByTestId("session-rename-dialog")).not.toBeVisible();
    await expect(manager.locator(`[data-session-id="${original.id}"]`)).toContainText("manager-work");
    await manager.getByRole("button", { name: "Close", exact: true }).first().click();
    expect(sessions()[0]!.pid).toBe(original.pid);
    const persisted = await readLayout(request);
    const mobile = await browser.newContext({ ...devices["Pixel 7"], viewport: { width: 320, height: 740 }, storageState: await context.storageState() });
    try {
      const phone = await mobile.newPage();
      await ready(phone, test.info().project.use.baseURL as string);
      await phone.getByTestId("shell-tab-terminal").click();
      await expect(phone.locator(".pdmux-pane-tag")).toHaveText("\uc6b4\uc601");
      await expect(phone.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(253, 224, 71)");
      const phonePane = phone.locator(`[data-pdmux-pane="${slot.id}"]`);
      await geometry(phonePane);
      await expect(phonePane.locator(".pdmux-pane-caption")).toContainText("manager-work");
      await phonePane.locator("[data-pdmux-pane-more]").click();
      await phone.locator("[data-pdmux-rename-session]").click();
      const phoneRename = phone.getByTestId("session-rename-dialog");
      const phoneRenameBounds = await phoneRename.boundingBox();
      expect(phoneRenameBounds!.x).toBeGreaterThanOrEqual(0);
      expect(phoneRenameBounds!.x + phoneRenameBounds!.width).toBeLessThanOrEqual(321);
      await phoneRename.locator("#terminal-session-name").fill("mobile-work");
      await phone.screenshot({ path: test.info().outputPath("mobile-session-rename.png") });
      await phoneRename.getByTestId("session-rename-save").click();
      await expect(phoneRename).not.toBeVisible();
      await expect(pane.locator(".pdmux-pane-caption")).toContainText("mobile-work", { timeout: 15_000 });
      expect(sessions()).toMatchObject([{ id: original.id, pid: original.pid, name: "mobile-work" }]);
      await phonePane.locator("[data-pdmux-pane-more]").click();
      await phone.locator("[data-pdmux-edit-presentation]").click();
      const mobileDialog = phone.getByTestId("terminal-presentation-dialog");
      const mobileBounds = await mobileDialog.boundingBox();
      expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
      expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(321);
      await editorGeometry(mobileDialog);
      await phone.screenshot({ path: test.info().outputPath("mobile-editor.png") });
      await mobileDialog.locator("#terminal-display-name").fill("Unsaved draft");
      await mobileDialog.getByLabel("Text color", { exact: true }).fill("#00ff00");
      await mobileDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(phonePane.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
      await expect(phonePane.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(253, 224, 71)");
      await phonePane.locator("[data-pdmux-pane-more]").click();
      await phone.locator("[data-pdmux-edit-presentation]").click();
      await expect(mobileDialog.getByLabel("Text color", { exact: true })).toHaveValue("#fde047");
      await mobileDialog.getByTestId("terminal-tag-text-auto").click();
      await mobileDialog.getByLabel("Background", { exact: true }).fill("#ffffff");
      await expect(mobileDialog.getByLabel("Text color", { exact: true })).toHaveValue("#000000");
      await mobileDialog.getByTestId("terminal-presentation-save").click();
      await expect.poll(async () => (await readLayout(request))?.payload.slots).toMatchObject([{ tags: [{ name: "\uc6b4\uc601", color: "#ffffff" }] }]);
      expect(((await readLayout(request))?.payload.slots as { tags: { textColor?: string }[] }[])[0]!.tags[0]!.textColor).toBeUndefined();
      await phone.reload(); await hydrated(phone);
      await phone.getByTestId("shell-tab-terminal").click();
      await expect(phonePane.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(0, 0, 0)");
      await phone.screenshot({ path: test.info().outputPath("mobile-automatic-text.png") });
      await phonePane.locator("[data-pdmux-pane-more]").click();
      await phone.locator("[data-pdmux-edit-presentation]").click();
      await expect(mobileDialog.getByTestId("terminal-tag-text-auto")).toBeDisabled();
      await mobileDialog.getByLabel("Background", { exact: true }).fill("#e11d48");
      await mobileDialog.getByLabel("Text color", { exact: true }).fill("#fde047");
      await mobileDialog.getByTestId("terminal-presentation-save").click();
      await expect(phonePane.locator(".pdmux-pane-tag")).toHaveCSS("color", "rgb(253, 224, 71)");
      // Create a session and detach its only viewer; it has no dashboard pane.
      await phone.evaluate(async ({ hostId }) => {
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/terminal/ws?hostId=${hostId}`);
          const timer = setTimeout(() => { socket.close(); reject(new Error("Unused session did not start")); }, 10_000);
          socket.onopen = () => socket.send(JSON.stringify({ type: "open", termId: "unused", target: { kind: "session", backend: "native", intent: "create", session: "cleanup-unused", cols: 80, rows: 24 } }));
          socket.onmessage = event => {
            const frame = JSON.parse(event.data) as { type: string; message?: string };
            if (frame.type === "ready") { clearTimeout(timer); socket.close(); resolve(); }
            else if (frame.type === "error") { clearTimeout(timer); socket.close(); reject(new Error(frame.message)); }
          };
        });
      }, { hostId });
      await expect.poll(() => sessions().length).toBe(2);
      const unused = sessions().find(item => item.name === "cleanup-unused")!;
      await phonePane.locator("[data-pdmux-pane-more]").click();
      await phone.locator("[data-pdmux-manage-sessions]").click();
      const phoneManager = phone.getByTestId("session-manager-dialog");
      await phoneManager.getByRole("textbox", { name: "Host or session", exact: true }).fill(fixtureHostName);
      await phoneManager.getByRole("button", { name: "Search", exact: true }).click();
      const unusedRow = phoneManager.locator(`[data-session-id="${unused.id}"]`);
      await expect(unusedRow).toBeVisible({ timeout: 15_000 });
      await unusedRow.click();
      const managerBounds = await phoneManager.boundingBox();
      expect(managerBounds!.x).toBeGreaterThanOrEqual(0);
      expect(managerBounds!.x + managerBounds!.width).toBeLessThanOrEqual(321);
      const overflow = await phoneManager.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
      const rowBounds = await unusedRow.boundingBox();
      expect(rowBounds!.width).toBeGreaterThan(managerBounds!.width * 0.65);
      expect(rowBounds!.height).toBeLessThan(150);
      const tableOverflow = await phoneManager.locator("[data-slot=table-container]").evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      expect(tableOverflow.scroll).toBeLessThanOrEqual(tableOverflow.client + 1);
      await expect(phoneManager.getByTestId("session-manager-terminate")).toBeEnabled();
      await phone.screenshot({ path: test.info().outputPath("session-manager-mobile.png") });
      await phoneManager.getByTestId("session-manager-terminate").click();
      const confirm = phone.getByTestId("session-terminate-confirm");
      await expect(confirm.getByTestId("session-terminate-target")).toContainText("cleanup-unused");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(sessions()).toHaveLength(2);
      await phoneManager.getByTestId("session-manager-terminate").click();
      await confirm.getByTestId("session-terminate-confirm-confirm").click();
      await expect(confirm).not.toBeVisible();
      await expect.poll(() => sessions().length).toBe(1);
      await expect(unusedRow).not.toBeVisible({ timeout: 15_000 });
      expect(sessions()[0]).toMatchObject({ id: original.id, pid: original.pid, name: "mobile-work" });
      await phoneManager.getByRole("button", { name: "Close", exact: true }).first().click();
    } finally { await mobile.close(); }
    if (!persisted) throw new Error("Saved personal layout disappeared");
    const presentation = (persisted.payload.slots as Record<string, unknown>[])[0]!;
    await writeLayout(request, { ...persisted, payload: { ...persisted.payload, mode: "split9", slots: Array.from({ length: 9 }, (_, index) => ({ ...presentation, id: `nine-${index}` })) } });
    await page.reload();
    await hydrated(page);
    await expect(page.locator(".pdmux-pane-alias")).toHaveCount(9);
    for (const cell of await page.locator("[data-pdmux-pane]").all()) await geometry(cell);
    await page.screenshot({ path: test.info().outputPath("nine-panes.png") });
    const evidence = JSON.stringify({ before, after, editors, originalPid: original.pid, opensBeforeEdit: count });
    await writeFile(test.info().outputPath("geometry.json"), evidence);
    await test.info().attach("geometry", { body: evidence, contentType: "application/json" });
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await writeLayout(request, saved).catch(() => undefined);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child!.once("exit", resolveExit));
      child.kill("SIGTERM");
      await exited;
    }
    if (existsSync(join(nativeRoot, "endpoint.json"))) {
      for (const session of sessions()) execFileSync(binary, ["session", "terminate", session.id, "--root", nativeRoot], { stdio: "ignore", windowsHide: true });
      await expect.poll(() => {
        try { execFileSync(binary, ["session", "stop", "--root", nativeRoot], { stdio: "ignore", windowsHide: true }); return true; }
        catch { return false; }
      }, { timeout: 10_000 }).toBe(true);
    }
    try {
      if (hostId) expect((await request.delete(`/api/hosts/${hostId}`).catch(() => null))?.ok()).toBe(true);
    } finally {
      if (legacy) { try { tmux("kill-server"); } catch { /* The private server already exited. */ } }
      await rm(directory, { recursive: true, force: true });
    }
  }
});
