// Verify backup, runtime shutdown and native window closure before installer handoff.
// Requires the desktop shell, desktop API and desktop web builds. No installed app is modified.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureNativeEngines, fixtureNativeSessions, stopFixtureNativeSessions } from './native-session-fixture.mjs';
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
import { desktopMessages } from ${JSON.stringify(pathToFileURL(join(repository,'apps/desktop/dist/i18n.js')).href)};
const { autoUpdater }=updaterPackage;
// Exercise the packaged install gate with the real development runtime.
// Only the disposable fixture replaces the installer; product downloads and signatures remain intact.
const original=UpdateCoordinator.prototype.installDownloadedUpdate;
UpdateCoordinator.prototype.installDownloadedUpdate=function(){Object.defineProperty(this,'packaged',{value:true});return original.call(this);};
const originalCheck=UpdateCoordinator.prototype.check;
UpdateCoordinator.prototype.check=function(manual){Object.defineProperty(this,'packaged',{value:true});return originalCheck.call(this,manual);};
app.setAsDefaultProtocolClient=()=>false;
app.getLocale=()=>"ko-KR";
const fixture=globalThis.__pdmuxFixture={available:false,holdCheck:false,downloadChoice:1,restartChoice:1,checkCalls:0,downloadCalls:0,dialogs:[],messages:desktopMessages("ko-KR")};
autoUpdater.checkForUpdates=async()=>{fixture.checkCalls++;if(fixture.holdCheck)await new Promise(resolve=>{fixture.finishCheck=resolve;});return {isUpdateAvailable:fixture.available,updateInfo:{version:"99.0.0"}};};
autoUpdater.downloadUpdate=async()=>{fixture.downloadCalls++;await new Promise(resolve=>{fixture.finishDownload=resolve;});return [];};
dialog.showMessageBox=async(...args)=>{const options=args.at(-1);fixture.dialogs.push({message:options.message,buttons:options.buttons});const response=options.buttons?.includes(fixture.messages.updateDownload)?fixture.downloadChoice:options.buttons?.includes(fixture.messages.updateInstall)?fixture.restartChoice:0;return {response,checkboxChecked:false};};
dialog.showErrorBox=(title,message)=>{throw new Error(title+': '+message);};
globalThis.__pdmuxFixtureProgress=percent=>autoUpdater.emit('download-progress',{percent,transferred:percent*1048576,total:100*1048576});
globalThis.__pdmuxFixtureSettings=()=>({autoDownload:autoUpdater.autoDownload,autoInstall:autoUpdater.autoInstallOnAppQuit});
autoUpdater.quitAndInstall=()=>{
 const window=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('devtools:'));
 const url=window.webContents.getURL();
 window.once('closed',()=>{writeFileSync(${JSON.stringify(report)},JSON.stringify({closed:true,url,order:'backup-runtime-close-install',checkCalls:fixture.checkCalls,downloadCalls:fixture.downloadCalls}));app.quit();});
 window.close();
 setTimeout(()=>{if(!window.isDestroyed())writeFileSync(${JSON.stringify(report)},JSON.stringify({closed:false,url}));},500);
};
await import(${JSON.stringify(pathToFileURL(join(repository,'apps/desktop/dist/main.js')).href)});
`);
let application;
let children=[];
const measurements=[];
try {
 application=await electron.launch({args:[wrapper,`--user-data-dir=${profile}`],env:{...process.env,TMUX:'',TMUX_TMPDIR:join(root,'tmux'),PDMUX_BUN_EXECUTABLE:process.env.PDMUX_BUN_EXECUTABLE ?? (process.versions.bun ? process.execPath : 'bun')},timeout:60000,chromiumSandbox:true});
 const page=await application.firstWindow({timeout:60000});
 await page.locator('html[data-hydrated=true]').waitFor({timeout:45000});
 await page.locator('[data-testid="shell-user"]').waitFor();
 const agent=await page.evaluate(()=>window.pdmuxDesktop.localAgent.status());
 assert.equal(agent.phase,'ready','Start the fixture embedded agent before testing its shutdown');
 async function until(predicate,message){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await application.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(message);}
 async function manualCheck(){const settings=page.locator('[data-testid="settings-dialog"]');if(!await settings.isVisible()){await page.locator('[data-testid="shell-user"]').click();await page.locator('[data-testid="shell-user-settings"]').click();await settings.waitFor();}await page.locator('[data-testid="settings-tab-advanced"]').click();await page.locator('[data-testid="desktop-menu-updates"]').click();}
 async function capture(progress,stage){await progress.locator('#message').waitFor();const geometry=await progress.evaluate(()=>{const body=document.body.getBoundingClientRect();const bar=document.querySelector('progress').getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,body:body.toJSON(),bar:bar.toJSON(),scrollHeight:document.documentElement.scrollHeight,message:document.querySelector('h1').textContent,detail:document.querySelector('#detail').textContent};});assert.ok(geometry.bar.width>300&&geometry.bar.height>=12&&geometry.bar.left>=0&&geometry.bar.right<=geometry.width&&geometry.scrollHeight<=geometry.height,'[TC-PDDESKTOP-008] progress fits its native window');measurements.push({stage,...geometry});await progress.screenshot({path:join(output,stage+'.png')});}
 await until(()=>globalThis.__pdmuxFixture.checkCalls===1,'Complete the quiet startup check');
 await application.evaluate(()=>{globalThis.__pdmuxFixture.holdCheck=true;});
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('http:')).hide());
 let nextWindow=application.waitForEvent('window');await page.evaluate(()=>{void window.pdmuxDesktop.actions.run('check-updates');});let progress=await nextWindow;
 await capture(progress,'checking');
 assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('http:')).isVisible()),true,'Show manual feedback even when the app was hidden to the tray');
 assert.equal(await progress.locator('progress').getAttribute('value'),null,'Use indeterminate progress while checking');
 await application.evaluate(()=>{globalThis.__pdmuxFixture.holdCheck=false;globalThis.__pdmuxFixture.finishCheck();});
 await until(()=>globalThis.__pdmuxFixture.dialogs.some(row=>row.message===globalThis.__pdmuxFixture.messages.updateCurrent),'[TC-PDDESKTOP-008] explicitly report no updates');
 await application.evaluate(()=>{globalThis.__pdmuxFixture.available=true;});
 await manualCheck();
 await until(()=>globalThis.__pdmuxFixture.dialogs.some(row=>row.buttons.includes(globalThis.__pdmuxFixture.messages.updateDownload)),'Offer the new version');
 assert.equal(await application.evaluate(()=>globalThis.__pdmuxFixture.downloadCalls),0,'[TC-PDDESKTOP-008] declining must not start a download');
 await application.evaluate(()=>{globalThis.__pdmuxFixture.downloadChoice=0;globalThis.__pdmuxFixture.holdCheck=true;});
 nextWindow=application.waitForEvent('window');await manualCheck();await nextWindow;
 nextWindow=application.waitForEvent('window');
 await application.evaluate(()=>{globalThis.__pdmuxFixture.holdCheck=false;globalThis.__pdmuxFixture.finishCheck();});
 progress=await nextWindow;
 await until(()=>typeof globalThis.__pdmuxFixture.finishDownload==='function','Start the approved download');
 await application.evaluate(()=>globalThis.__pdmuxFixtureProgress(42));
 await progress.waitForFunction(()=>document.querySelector('#detail').textContent.startsWith('42%'));
 await capture(progress,'download-42');
 await application.evaluate(()=>globalThis.__pdmuxFixtureProgress(87));
 await progress.waitForFunction(()=>document.querySelector('#detail').textContent.startsWith('87%'));
 await capture(progress,'download-87');
 await application.evaluate(()=>globalThis.__pdmuxFixture.finishDownload());
 await until(()=>globalThis.__pdmuxFixture.dialogs.some(row=>row.message===globalThis.__pdmuxFixture.messages.updateReady),'[TC-PDDESKTOP-008] report completion and offer restart');
 assert.equal(page.isClosed(),false,'Postponing restart leaves the workspace running');
 assert.equal(await page.evaluate(() => window.pdmuxDesktop.localAgent.status().then(value=>value.phase)),'ready');
 assert.deepEqual(await application.evaluate(()=>globalThis.__pdmuxFixtureSettings()),{autoDownload:false,autoInstall:false},'Only explicit coordinator actions drive the fixture');
 await page.screenshot({path:join(output,'before-install.png')});
 const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,panes:document.querySelectorAll('[data-pdmux-pane]').length}));
 const pid=application.process().pid;
 const rows=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m?{pid:Number(m[1]),parent:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
 const parentIds=new Set([pid]);
 for(let pass=0;pass<5;pass++) for(const row of rows) if(parentIds.has(row.parent))parentIds.add(row.pid);
 const engines=await fixtureNativeEngines(root);
 const nativeBefore=engines.map(engine=>({engine,sessions:fixtureNativeSessions(engine)}));
 assert.ok(nativeBefore.some(item=>item.sessions.length>0),'Capture the fixture native session before the update');
 children=rows.filter(row=>parentIds.has(row.pid)&&row.pid!==pid&&(/(?:^|\/)bun$|pdmux-agent$/.test(row.command))&&!row.command.includes('/sessions/')).map(row=>row.pid);
 assert.ok(children.length>=2,'Capture this fixture API and web processes');
 const checks=await application.evaluate(()=>globalThis.__pdmuxFixture.checkCalls);
 await application.evaluate(()=>{globalThis.__pdmuxFixture.restartChoice=0;});
 await manualCheck();
 const deadline=Date.now()+20000;
 let result;
 while(Date.now()<deadline){try{result=JSON.parse(await readFile(report,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.equal(result?.closed,true,'[TC-PDDESKTOP-008] update must close the actual window instead of hiding it');
 assert.equal(result.checkCalls,checks,'Reuse the staged update when restarting later');
 assert.equal(result.downloadCalls,1,'Download the approved update exactly once');
 let stopped=false;try{await fetch(result.url,{signal:AbortSignal.timeout(1500)});}catch{stopped=true;}
 assert.equal(stopped,true,'Stop the local gateway before handing off installation');
 const { readdir }=await import('node:fs/promises');
 const backups=await readdir(join(profile,'backups'));
 assert.ok(backups.some(name=>!name.startsWith('.')),'Complete an update backup');
 await new Promise(resolve=>setTimeout(resolve,500));
 for(const child of children){let running=true;try{process.kill(child,0);}catch{running=false;}assert.equal(running,false,`Stop fixture runtime process ${child}`);}
 for(const {engine,sessions} of nativeBefore)assert.deepEqual(fixtureNativeSessions(engine).map(({id,pid})=>({id,pid})),sessions.map(({id,pid})=>({id,pid})),'Preserve native programs across installer handoff');
 const evidence={stage:'desktop-update-shutdown',result:'passed',...result,gatewayStopped:stopped,runtimeProcessesStopped:children.length,nativeSessionsPreserved:true,backupCount:backups.length,geometry,checks,measurements,nativeInstallation:'Network and native dialog choices stubbed; real progress windows, Electron window and local runtime'};
 await writeFile(join(output,'result.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence));
}finally{
 if(application)await application.close().catch(()=>undefined);
 await stopFixtureNativeSessions(root);
 await rm(root,{recursive:true,force:true});
}
