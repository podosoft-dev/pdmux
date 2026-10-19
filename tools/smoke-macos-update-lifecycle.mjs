// Verify backup, runtime shutdown and native window closure before installer handoff.
// Requires the desktop shell, desktop API and desktop web builds. No installed app is modified.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.equal(process.platform, 'darwin', 'Run the window lifecycle probe on native macOS');
const repository=resolve(import.meta.dirname, '..');
const require=createRequire(join(repository,'package.json'));
const { _electron: electron }=require('playwright');
const output=resolve(process.env.PDMUX_UPDATE_OUTPUT ?? join(repository, '../output/playwright/desktop-update'));
await mkdir(output, { recursive: true });
const root=await mkdtemp('/tmp/pdmux-updater-');
const profile=join(root,'profile'); await mkdir(profile); await mkdir(join(root,'tmux'));
const wrapper=join(root,'main.mjs');
const report=join(root,'result.json');
await writeFile(wrapper, `
import { app, BrowserWindow, dialog } from "electron";
import { writeFileSync } from "node:fs";
import updaterPackage from ${JSON.stringify(pathToFileURL(require.resolve('electron-updater')).href)};
import { UpdateCoordinator } from ${JSON.stringify(pathToFileURL(join(repository,'apps/desktop/dist/updater.js')).href)};
const { autoUpdater }=updaterPackage;
// Exercise the packaged install gate with the real development runtime.
// Only the disposable fixture replaces the installer; product downloads and signatures remain intact.
const original=UpdateCoordinator.prototype.installDownloadedUpdate;
UpdateCoordinator.prototype.installDownloadedUpdate=function(){Object.defineProperty(this,'packaged',{value:true});return original.call(this);};
app.setAsDefaultProtocolClient=()=>false;
autoUpdater.checkForUpdates=async()=>null;
dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
dialog.showErrorBox=(title,message)=>{throw new Error(title+': '+message);};
globalThis.__pdmuxFixtureTrigger=()=>autoUpdater.emit('update-downloaded');
autoUpdater.quitAndInstall=()=>{
 const window=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('devtools:'));
 const url=window.webContents.getURL();
 window.once('closed',()=>{writeFileSync(${JSON.stringify(report)},JSON.stringify({closed:true,url,order:'backup-runtime-close-install'}));app.quit();});
 window.close();
 setTimeout(()=>{if(!window.isDestroyed())writeFileSync(${JSON.stringify(report)},JSON.stringify({closed:false,url}));},500);
};
await import(${JSON.stringify(pathToFileURL(join(repository,'apps/desktop/dist/main.js')).href)});
`);
let application;
let children=[];
try {
 application=await electron.launch({args:[wrapper,`--user-data-dir=${profile}`],env:{...process.env,TMUX:'',TMUX_TMPDIR:join(root,'tmux'),PDMUX_BUN_EXECUTABLE:process.env.PDMUX_BUN_EXECUTABLE ?? (process.versions.bun ? process.execPath : 'bun')},timeout:60000,chromiumSandbox:true});
 const page=await application.firstWindow({timeout:60000});
 await page.locator('html[data-hydrated=true]').waitFor({timeout:45000});
 await page.locator('[data-testid="shell-user"]').waitFor();
 const agent=await page.evaluate(()=>window.pdmuxDesktop.localAgent.status());
 assert.equal(agent.phase,'ready','Start the fixture embedded agent before testing its shutdown');
 await page.screenshot({path:join(output,'before-install.png')});
 const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,panes:document.querySelectorAll('[data-pdmux-pane]').length}));
 const pid=application.process().pid;
 const rows=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m?{pid:Number(m[1]),parent:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
 const parentIds=new Set([pid]);
 for(let pass=0;pass<5;pass++) for(const row of rows) if(parentIds.has(row.parent))parentIds.add(row.pid);
 children=rows.filter(row=>parentIds.has(row.pid)&&row.pid!==pid&&(/\/bun$|pdmux-agent$/.test(row.command))).map(row=>row.pid);
 assert.ok(children.length>=2,'Capture this fixture API and web processes');
 await application.evaluate(()=>globalThis.__pdmuxFixtureTrigger());
 const deadline=Date.now()+20000;
 let result;
 while(Date.now()<deadline){try{result=JSON.parse(await readFile(report,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.equal(result?.closed,true,'[TC-PDDESKTOP-008] update must close the actual window instead of hiding it');
 let stopped=false;try{await fetch(result.url,{signal:AbortSignal.timeout(1500)});}catch{stopped=true;}
 assert.equal(stopped,true,'Stop the local gateway before handing off installation');
 const { readdir }=await import('node:fs/promises');
 const backups=await readdir(join(profile,'backups'));
 assert.ok(backups.some(name=>!name.startsWith('.')),'Complete an update backup');
 await new Promise(resolve=>setTimeout(resolve,500));
 for(const child of children){let running=true;try{process.kill(child,0);}catch{running=false;}assert.equal(running,false,`Stop fixture runtime process ${child}`);}
 const evidence={stage:'desktop-update-shutdown',result:'passed',...result,gatewayStopped:stopped,runtimeProcessesStopped:children.length,backupCount:backups.length,geometry,nativeInstallation:'Installer handoff stubbed; real Electron window and local runtime'};
 await writeFile(join(output,'result.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence));
}finally{
 if(application)await application.close().catch(()=>undefined);
 await rm(root,{recursive:true,force:true});
}
