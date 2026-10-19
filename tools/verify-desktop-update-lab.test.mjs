import { expect, it } from "bun:test";

it.skipIf(process.env.PDMUX_NATIVE_UPDATE_LAB!=="1")("[TC-PDDESKTOP-008] installs a real signed update from the local feed and preserves the desktop profile",async()=>{
  const child=Bun.spawn([process.execPath,new URL("./verify-desktop-update-lab.mjs",import.meta.url).pathname],{stdout:"pipe",stderr:"pipe",env:process.env});
  const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0)throw new Error(output+"\n"+errors);
  expect(output).toContain('"realSquirrelInstall":true');expect(output).toContain('"result":"passed"');
},360000);
