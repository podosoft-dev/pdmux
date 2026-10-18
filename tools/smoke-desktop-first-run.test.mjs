import { describe, expect, it } from "bun:test";

describe("[TC-PDDESKTOP-016] rendered native desktop menu and first terminal", () => {
  it.skipIf(process.env.PDMUX_DESKTOP_UI_TEST !== "1")("fits the menu and operates #1 through the real Electron preload", async () => {
    const child = Bun.spawn([process.execPath, new URL("./smoke-desktop-first-run.mjs", import.meta.url).pathname], { stdout:"pipe",stderr:"pipe",env:process.env });
    const [output,errors,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if (code !== 0) throw new Error(`${output}\n${errors}`);
    expect(output).toContain('"stage":"desktop-first-run","result":"passed"');
  },120_000);
});
