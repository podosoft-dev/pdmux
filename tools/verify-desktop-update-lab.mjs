import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { assertLabStopped, labAppName, labDirectory, readLab } from "./desktop-update-lab.mjs";
import { designatedRequirement } from "./probe-macos-adhoc-update.mjs";
import { signingEnvironment } from "./apple-signing.mjs";
import { getAppCacheDir } from "electron-updater/out/AppAdapter.js";

assert.equal(process.platform,"darwin","Verify real macOS updates on a native Mac");
const nativeDialogs=process.argv.includes("--native-dialogs");
const lab=await readLab();
const output=join(labDirectory,"evidence");await mkdir(output,{recursive:true});
const server=JSON.parse(await readFile(join(labDirectory,"server.json"),"utf8"));
assert.equal(new URL(server.origin).hostname,"127.0.0.1");
assert.equal((await fetch(server.origin+"/health")).status,200,"Start the loopback feed first");
await assertLabStopped();
const app=join(labDirectory,"installed",labAppName);
const installedVersion=spawnSync("/usr/libexec/PlistBuddy",["-c","Print CFBundleShortVersionString",join(app,"Contents/Info.plist")],{encoding:"utf8"});
assert.equal(installedVersion.stdout.trim(),lab.builds[0].version,"Reset the lab to its baseline before verification");
await writeFile(join(labDirectory,"channel.json"),JSON.stringify({version:"0.0.1"}));
await writeFile(join(labDirectory,"events.jsonl"),"");
// This name comes from the lab-only package identity, never the installed product's cache.
await rm(join(getAppCacheDir(),"pdmux-update-lab-updater"),{recursive:true,force:true});
const requirement=spawnSync("codesign",["-d","-r-",app],{encoding:"utf8"});assert.equal(requirement.status,0);
const target=join(lab.builds[1].directory,`mac${process.arch==="arm64"?"-arm64":""}`,labAppName);
const signature=spawnSync("codesign",["--verify","--deep","--strict","-R",`=${designatedRequirement(requirement.stdout+requirement.stderr)}`,target],{encoding:"utf8"});assert.equal(signature.status,0,"The candidate must satisfy the unchanged baseline signing requirement");
let application;
let baseline;
const captures=[];
async function events(){return(await readFile(join(labDirectory,"events.jsonl"),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}
async function until(read,message,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(message);}
function stage(name){console.log(JSON.stringify({stage:name,nativeDialogs,at:new Date().toISOString()}));}
async function captureProgress(page){
  try{
    await page.waitForLoadState("domcontentloaded");
    if(!page.url().startsWith("data:"))return;
    await page.locator("#progress").waitFor();
    let checking=false;let first=false;let second=false;
    while(!page.isClosed()){
      const state=await page.evaluate(()=>({value:document.querySelector('progress').getAttribute('value'),detail:document.querySelector('#detail').textContent,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,bar:document.querySelector('progress').getBoundingClientRect().toJSON(),scroll:document.documentElement.scrollHeight}));
      const pct=state.value===null?null:Number(state.value);
      let name;
      if(pct===null&&!checking&&!captures.some(item=>item.name==="checking")){name="checking";checking=true;}
      if(pct>=25&&pct<75&&!first){name="download-25";first=true;}
      if(pct>=75&&!second){name="download-75";second=true;}
      if(name){assert.ok(state.bar.width>300&&state.bar.right<=state.width&&state.scroll<=state.height);await page.screenshot({path:join(output,name+".png")});captures.push({name,...state});stage(name);}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
  }catch(error){if(!page.isClosed())throw error;}
}
try{
  application=await electron.launch({executablePath:join(app,"Contents/MacOS/pdmux-update-lab"),env:{...signingEnvironment(process.env),PDMUX_UPDATE_LAB_AUTO_CONFIRM:nativeDialogs?"0":"1"},timeout:120000,chromiumSandbox:true});
  const monitors=[];application.on("window",page=>{monitors.push(captureProgress(page));});
  const page=await application.firstWindow({timeout:120000});await page.waitForURL(url=>url.hostname==="127.0.0.1",{timeout:60000});await page.locator('html[data-hydrated="true"]').waitFor();
  baseline=await until(async()=> (await events()).find(event=>event.event==="ready"&&event.version==="0.0.1"),"The baseline app must be ready");
  const marker="local-update-preserved";
  const saved=await page.evaluate(async ({id,marker})=>(await fetch(`/api/hosts/${id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({description:marker})})).status,{id:baseline.agent.hostId,marker});assert.equal(saved,200);
  await writeFile(join(labDirectory,"profile/lab-sentinel.txt"),marker);
  async function check(){const settings=page.locator('[data-testid="settings-dialog"]');if(!await settings.isVisible()){await page.locator('[data-testid="shell-user"]').click();await page.locator('[data-testid="shell-user-settings"]').click();await settings.waitFor();}await page.locator('[data-testid="settings-tab-advanced"]').click();await page.locator('[data-testid="desktop-menu-updates"]').click();}
  stage("no-update-check");await check();
  await until(async()=> (await events()).some(event=>event.event==="dialog-result"),"Close the no-update notice");
  await page.screenshot({path:join(output,"baseline.png")});
  await writeFile(join(labDirectory,"channel.json"),JSON.stringify({version:"0.0.2"}));
  stage("candidate-published");await check();
  await until(async()=> (await events()).some(event=>event.event==="progress"),"Confirm downloading the candidate");
  stage("downloading-real-archive");
  await until(async()=> (await events()).filter(event=>event.event==="dialog").length>=3,"The actual download must complete before restart is offered");
  stage("restart-confirmation");
  const updated=await until(async()=> (await events()).find(event=>event.event==="ready"&&event.version==="0.0.2"),"Confirm restart and wait for the updated app",240000);
  assert.equal(updated.profile,baseline.profile,"Preserve the isolated profile across a real native relaunch");
  assert.equal(updated.secretHash,baseline.secretHash,"Preserve the local authentication secret");
  assert.equal(updated.agent.hostId,baseline.agent.hostId,"Keep the original local host");
  assert.equal(updated.hosts.find(host=>host.id===baseline.agent.hostId).description,marker,"Preserve API-written settings");
  assert.equal(await readFile(join(labDirectory,"profile/lab-sentinel.txt"),"utf8"),marker);
  assert.ok((await readdir(join(labDirectory,"profile/backups"))).length>0,"Create an update backup");
  const installedSignature=spawnSync("codesign",["--verify","--deep","--strict","-R","="+designatedRequirement(requirement.stdout+requirement.stderr),app],{encoding:"utf8"});
  assert.equal(installedSignature.status,0,"The installed app must retain the original signing requirement");
  const notarization=spawnSync("xcrun",["stapler","validate",app],{encoding:"utf8"});
  assert.equal(notarization.status,0,"The installed app must retain its Apple notarization ticket");
  await Promise.all(monitors);
  assert.ok(captures.some(item=>item.name==="download-25")&&captures.some(item=>item.name==="download-75"),"Capture actual download progress changing");
  const result={result:"passed",baseline:baseline.version,updated:updated.version,sourceVersion:lab.sourceVersion,profilePreserved:true,authSecretPreserved:true,hostAndSettingsPreserved:true,realDownload:true,realSquirrelInstall:true,signatureVerified:true,notarizationTicketVerified:true,nativeDialogs,captures,app};
  await writeFile(join(output,"result.json"),JSON.stringify(result,null,2));stage("passed");console.log(JSON.stringify(result));
}catch(error){await writeFile(join(output,"failure.json"),JSON.stringify({message:error.message},null,2));throw error;}
finally{if(application){try{await application.close();}catch{}}}
