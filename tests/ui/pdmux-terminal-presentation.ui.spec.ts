import { devices, type Locator } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/pdmux-test";
import { ready } from "../helpers/hydration";
import { readLayout, writeLayout } from "../helpers/pdmux-layout";
import { parseAgentVersion } from "../../apps/desktop/src/staging";

// Manual verification can reuse an explicitly supplied disposable account without
// running the shared account setup or revoking any existing browser sessions.
if (process.env.PDMUX_PRESENTATION_STORAGE_STATE) test.use({ e2eState: process.env.PDMUX_PRESENTATION_STORAGE_STATE });

test("[TC-PDUI-236] [TC-PDTERM-022] personal names and colored tags preserve a native session across editing, reload and detach", async ({ page, request, context, browser }) => {
  test.setTimeout(120_000);
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
  let hostId = "";
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
  try {
    const created = await request.post("/api/hosts", { data: { label: `presentation-${Date.now()}` } });
    expect(created.ok(), `Create the disposable host: ${await created.text()}`).toBe(true);
    hostId = ((await created.json()) as { id: string }).id;
    const minted = await request.post(`/api/hosts/${hostId}/tokens`, { data: { name: "presentation-test" } });
    expect(minted.ok()).toBe(true);
    const { token } = await minted.json() as { token: string };
    await writeFile(config, JSON.stringify({ server: process.env.PDMUX_PRESENTATION_AGENT_ORIGIN ?? test.info().project.use.baseURL, token, hostname: "presentation-fixture", logLevel: "error" }), { mode: 0o600 });
    child = spawn(binary, ["run"], { env: { ...process.env, PDMUX_CONFIG: config, PDMUX_STATE_DIR: join(directory, "state"), PDMUX_TMUX_SOCKET: join(directory, "tmux.sock") }, stdio: "ignore", windowsHide: true });
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
    await dialog.locator('input[type="color"]').fill("#e11d48");
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath("editor.png") });
    await dialog.getByTestId("terminal-presentation-save").click();
    await expect(pane.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
    await expect(pane.locator(".pdmux-pane-tag")).toHaveText("\uc6b4\uc601");
    await expect(pane.locator(".pdmux-pane-tag")).toHaveCSS("background-color", "rgb(225, 29, 72)");
    await expect(surface).toHaveAttribute("data-presentation-probe", "same-surface");
    expect(opens).toBe(count);
    expect(sessions()[0]!.pid).toBe(original.pid);
    const after = await geometry(pane);
    await expect.poll(async () => (await readLayout(request))?.payload.slots).toMatchObject([{ label: "\uacb0\uc81c API \uc791\uc5c5", tags: [{ name: "\uc6b4\uc601", color: "#e11d48" }], sessionId: original.id }]);
    await page.screenshot({ path: test.info().outputPath("saved.png") });
    await page.reload();
    await expect(pane.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
    expect(sessions()[0]!.pid).toBe(original.pid);
    await pane.locator("[data-pdmux-pane-more]").click();
    const popupPromise = context.waitForEvent("page");
    await page.locator("[data-pdmux-detach]").click();
    const popup = await popupPromise;
    try {
      await expect(popup.locator(".pdmux-pane-tag")).toHaveText("\uc6b4\uc601");
      await expect(popup).toHaveTitle("\uacb0\uc81c API \uc791\uc5c5 · PDMux");
      await popup.reload();
      await expect(popup.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
      expect(sessions()[0]!.pid).toBe(original.pid);
    } finally { await popup.close(); }
    const persisted = await readLayout(request);
    const mobile = await browser.newContext({ ...devices["Pixel 7"], viewport: { width: 320, height: 740 }, storageState: await context.storageState() });
    try {
      const phone = await mobile.newPage();
      await ready(phone, test.info().project.use.baseURL as string);
      await phone.getByTestId("shell-tab-terminal").click();
      await expect(phone.locator(".pdmux-pane-tag")).toHaveText("\uc6b4\uc601");
      const phonePane = phone.locator(`[data-pdmux-pane="${slot.id}"]`);
      await geometry(phonePane);
      await phonePane.locator("[data-pdmux-pane-more]").click();
      await phone.locator("[data-pdmux-edit-presentation]").click();
      const mobileDialog = phone.getByTestId("terminal-presentation-dialog");
      const mobileBounds = await mobileDialog.boundingBox();
      expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
      expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(321);
      await phone.screenshot({ path: test.info().outputPath("mobile-editor.png") });
      await mobileDialog.locator("#terminal-display-name").fill("Unsaved draft");
      await mobileDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(phonePane.locator(".pdmux-pane-alias")).toHaveText("\uacb0\uc81c API \uc791\uc5c5");
    } finally { await mobile.close(); }
    if (!persisted) throw new Error("Saved personal layout disappeared");
    const presentation = (persisted.payload.slots as Record<string, unknown>[])[0]!;
    await writeLayout(request, { ...persisted, payload: { ...persisted.payload, mode: "split9", slots: Array.from({ length: 9 }, (_, index) => ({ ...presentation, id: `nine-${index}` })) } });
    await page.reload();
    await expect(page.locator(".pdmux-pane-alias")).toHaveCount(9);
    for (const cell of await page.locator("[data-pdmux-pane]").all()) await geometry(cell);
    await page.screenshot({ path: test.info().outputPath("nine-panes.png") });
    await test.info().attach("geometry", { body: JSON.stringify({ before, after, originalPid: original.pid, opensBeforeEdit: count }), contentType: "application/json" });
  } finally {
    await page.goto("about:blank");
    await writeLayout(request, saved);
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolveExit => child!.once("exit", resolveExit)); }
    if (existsSync(join(nativeRoot, "endpoint.json"))) {
      for (const session of sessions()) execFileSync(binary, ["session", "terminate", session.id, "--root", nativeRoot], { stdio: "ignore", windowsHide: true });
      await expect.poll(() => {
        try { execFileSync(binary, ["session", "stop", "--root", nativeRoot], { stdio: "ignore", windowsHide: true }); return true; }
        catch { return false; }
      }, { timeout: 10_000 }).toBe(true);
    }
    if (hostId) expect((await request.delete(`/api/hosts/${hostId}`)).ok()).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
