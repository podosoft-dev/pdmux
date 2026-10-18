import { mkdtemp, mkdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { verifyDesktopFirstRun } from "./desktop-first-run.mjs";
const repository = resolve(import.meta.dirname,"..");
const directory = await mkdtemp(join(tmpdir(),"pdmux-first-run-"));
const tmux = join(directory,"tmux"); await mkdir(tmux);
const application = await electron.launch({args:[join(repository,"apps/desktop"),`--user-data-dir=${directory}`],env:{...process.env,PDMUX_BUN_EXECUTABLE:process.execPath,TMUX:"",TMUX_TMPDIR:tmux},timeout:120_000,chromiumSandbox:true});
application.process().stderr?.on("data", bytes => { void appendFile("/tmp/pdmux-first-run-runtime.log",bytes); });
application.process().stdout?.on("data", bytes => { void appendFile("/tmp/pdmux-first-run-runtime.log",bytes); });
let page;
try {
 page = await application.firstWindow({timeout:120_000});
 await page.locator('[data-testid="shell-user"]').waitFor({timeout:60_000});
 await verifyDesktopFirstRun(page,process.argv[2] ?? "/tmp/pdmux-desktop-first-run.png");
 // Hold client modules while SSR is already visible: interacting before hydration
 // used to lose the menu click on slower fresh and restarted CI installations.
 let releaseModules;
 const modules = new Promise(resolve => { releaseModules = resolve; });
 await page.route("**/_app/immutable/**/*.js", async route => { await modules; await route.continue(); });
 await page.goto(page.url(), { waitUntil:"commit" });
 await page.locator('[data-testid="shell-user"]').waitFor();
 const delayed = verifyDesktopFirstRun(page,"/tmp/pdmux-desktop-hydration-menu.png",{fresh:false});
 setTimeout(releaseModules,300);
 await delayed;
 await page.unroute("**/_app/immutable/**/*.js");
 await page.locator('[data-testid="shell-user"]').click();
 await page.locator('[data-testid="shell-server-connection"]').click();
 await page.waitForURL("**/connection");
 await page.locator('[data-testid="desktop-local-host"]').waitFor({timeout:10_000});
 await page.screenshot({path:"/tmp/pdmux-desktop-local-connection.png"});
 console.log(JSON.stringify({stage:"desktop-first-run",result:"passed"}));
} finally { if (page && !page.isClosed()) { await page.screenshot({path:"/tmp/pdmux-desktop-first-run-last.png"}); console.log(JSON.stringify({stage:"desktop-first-run-page",url:page.url()})); } await application.close(); await rm(directory,{recursive:true,force:true}); }
