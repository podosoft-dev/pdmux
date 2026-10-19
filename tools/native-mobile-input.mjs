// [TC-PDTERM-130] Device emulation is not physical iOS/Android validation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { devices, webkit } from 'playwright';

async function touchDrag(page, locator, direction, chromium) {
  const box = await locator.boundingBox(); assert.ok(box);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height * (direction > 0 ? .3 : .7));
  const distance = Math.min(120, box.height * .35) * direction;
  if (chromium) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x,y}] });
    for (let i=1;i<=8;i++) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+distance*i/8}]});
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await cdp.detach();
  } else {
    // WebKit has no CDP touch injection. Exercise JS routing, without claiming
    // a trusted gesture or the native iOS selection/context menu was tested.
    await locator.evaluate(async (element, {x,y,distance}) => {
      function event(type, points) {
        const value=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperty(value,'touches',{value:points.map(p=>({clientX:p.x,clientY:p.y}))});
        element.dispatchEvent(value);
      }
      event('touchstart',[{x,y}]);
      for(let i=1;i<=8;i++){event('touchmove',[{x,y:y+distance*i/8}]);await new Promise(resolve=>setTimeout(resolve,20));}
      event('touchend',[]);
    },{x,y,distance});
  }
}

export async function verifyNativeMobileInput(options) {
  const { application, browser, origin, cookies, hostId, root, output, watch, command, text, until } = options;
  await mkdir(output,{recursive:true});
  const receiver=join(root,'mobile-paste.py');
  await writeFile(receiver, `import os,sys,termios,tty,base64\nold=termios.tcgetattr(0); tty.setraw(0)\ntry:\n sys.stdout.write('\\x1b[?2004hMOBILE_PASTE_READY'); sys.stdout.flush()\n data=b''\n while b'\\x1b[201~' not in data: data+=os.read(0,4096)\n payload=data.split(b'\\x1b[200~',1)[1].split(b'\\x1b[201~',1)[0]\n sys.stdout.write('\\r\\nWIRE_'+base64.b64encode(payload).decode()+'\\r\\nCOPY_MOBILE_한글🙂\\r\\n'); sys.stdout.flush()\nfinally:\n sys.stdout.write('\\x1b[?2004l'); sys.stdout.flush(); termios.tcsetattr(0,termios.TCSADRAIN,old)\n`);
  const results=[];
  const savedClipboard=await application.evaluate(({clipboard})=>clipboard.readText());
  let safari;
  try {
    for(const platform of (process.env.PDMUX_NATIVE_INPUT_MOBILE_PLATFORMS?.split(',')??['android-chromium','iphone-webkit'])) {
      const isChromium=platform==='android-chromium';
      if(!isChromium) safari=await webkit.launch({headless:false});
      const engine=isChromium?browser:safari;
      const {defaultBrowserType,...device}=devices[isChromium?'Pixel 7':'iPhone 13'];
      const context=await engine.newContext({...device});
      await context.addCookies(cookies);
      if(isChromium) await context.grantPermissions(['clipboard-read','clipboard-write']);
      const page=await context.newPage(); const state=watch(page);
      const historyResponses=[];
      page.on('response',async response=>{
        if(response.url().includes('/history')) historyResponses.push({request:response.request().postData(),status:response.status(),body:await response.text().catch(()=>null)});
      });
      const name=`mobile-${isChromium?'android':'iphone'}`;
      // Use the actual dashboard with the phone's three bottom tabs. A detached
      // terminal lacks that shell and cannot prove this mobile workflow.
      const prefs=await (await context.request.get(`${origin}/api/prefs`)).json();
      const saved=prefs.layouts.find(layout=>layout.isDefault)??prefs.layouts[0];
      assert.ok(saved);
      const layoutUrl=`${origin}/api/prefs/layouts/${encodeURIComponent(saved.name)}`;
      const save=async payload=>{
        const response=await context.request.put(layoutUrl,{headers:{origin},data:{payload,isDefault:saved.isDefault}});
        assert.ok(response.ok(),`mobile fixture layout: ${response.status()}`);
      };
      await save({...saved.payload,mode:'split4',page:0,focusId:`${name}-slot`,slots:[{id:`${name}-slot`,hostId,kind:'new',session:name,backend:'native',intent:'create'}]});
      await page.goto(`${origin}/`);
      await page.bringToFront();
      const tabs=page.locator('[data-pdmux-region="tabs"]');
      await tabs.waitFor({state:'visible'});
      for(const tab of ['hosts','terminal','git']) assert.ok(await page.getByTestId(`shell-tab-${tab}`).isVisible());
      const deviceState=await page.evaluate(()=>({userAgent:navigator.userAgent,touchPoints:navigator.maxTouchPoints,touchEvents:'ontouchstart' in window,coarse:matchMedia('(pointer: coarse)').matches,viewport:{width:innerWidth,height:innerHeight}}));
      // macOS WebKit exposes emulated touch events/coarse pointer but reports
      // maxTouchPoints=0. Keep that limitation in the evidence instead of faking it.
      assert.ok(deviceState.coarse&&deviceState.touchEvents);
      if(isChromium) assert.ok(deviceState.touchPoints>0);
      assert.match(deviceState.userAgent,isChromium?/Android/:/iPhone/);
      const tabsBox=await tabs.boundingBox();
      assert.ok(tabsBox&&tabsBox.y>deviceState.viewport.height*.7&&tabsBox.y+tabsBox.height<=deviceState.viewport.height+1);
      await page.getByTestId('shell-tab-terminal').tap();
      await until(()=>state.screen,Boolean,`${platform} native session`);
      const surface=page.locator('[data-pdmux-surface]');
      await surface.evaluate(element=>{element.dataset.nativeMobileProbe='preserved';});
      for(const tab of ['hosts','git','terminal']) await page.getByTestId(`shell-tab-${tab}`).tap();
      assert.equal(await surface.getAttribute('data-native-mobile-probe'),'preserved');
      await page.screenshot({path:join(output,`${platform}-dashboard-tabs.png`)});
      const composer=page.getByTestId('terminal-composer-input');
      assert.ok(await composer.isVisible());
      const composedCommand="printf '%s%s\\n' 'MOBILE_COMPOSER_' '한글🙂'";
      await application.evaluate(({clipboard},value)=>clipboard.writeText(value),composedCommand);
      await page.evaluate(()=>{window.composerPasteProbe=[];document.addEventListener('paste',event=>window.composerPasteProbe.push({target:event.target?.getAttribute('data-testid'),text:event.clipboardData?.getData('text/plain')}),{capture:true});});
      await composer.tap(); await page.keyboard.press('Meta+V');
      await new Promise(resolve=>setTimeout(resolve,300));
      await writeFile(join(output,`${platform}-composer-debug.json`),JSON.stringify(await page.evaluate(()=>({events:window.composerPasteProbe,active:{tag:document.activeElement?.tagName,id:document.activeElement?.getAttribute('data-testid'),value:document.activeElement?.value},visibility:document.visibilityState,focused:document.hasFocus()})),null,2));
      await until(()=>composer.inputValue(),value=>value===composedCommand,`${platform} clipboard reaches composer`);
      await page.getByTestId('terminal-composer-send').tap();
      await until(()=>text(page),value=>value.includes('MOBILE_COMPOSER_한글🙂'),`${platform} composer clipboard command executes`);
      await command(page, `for i in $(seq 1 140); do printf 'MOBILE_ROW_%03d\\n' "$i"; done`);
      await until(()=>text(page),value=>value.includes('MOBILE_ROW_140'),`${platform} shell output`);
      await touchDrag(page,surface,1,isChromium);
      await until(()=>state.screen?.history,value=>value>0,`${platform} shell touch reaches history`);
      await page.screenshot({path:join(output,`${platform}-shell-scroll.png`)});
      await page.locator('[data-pdmux-history]').tap();
      const history=page.locator('[data-pdmux-popover="terminal-history"]');
      await new Promise(resolve=>setTimeout(resolve,700));
      await writeFile(join(output,`${platform}-history-debug.json`),JSON.stringify({text:await history.innerText(),responses:historyResponses,url:page.url()},null,2));
      await page.screenshot({path:join(output,`${platform}-history-debug.png`)});
      await until(()=>history.innerText(),value=>value.includes('MOBILE_ROW_001'),`${platform} full native history`);
      const geometry=await history.evaluate(element=>({box:element.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},body:(()=>{const b=element.querySelector('[data-pdmux-history-body]');return {height:b.clientHeight,scroll:b.scrollHeight,userSelect:getComputedStyle(b).userSelect}})()}));
      assert.ok(geometry.box.width>250 && geometry.box.height>200);
      assert.ok(geometry.box.x>=0 && geometry.box.right<=geometry.viewport.width+1);
      assert.ok(geometry.body.scroll>geometry.body.height);
      assert.notEqual(geometry.body.userSelect,'none');
      await page.getByTestId('terminal-history-copy').tap();
      await until(()=>application.evaluate(({clipboard})=>clipboard.readText()),value=>value.includes('MOBILE_ROW_001') && !value.includes('\x1b'),`${platform} copy button writes plain text to clipboard`);
      await history.screenshot({path:join(output,`${platform}-history-copy.png`)});
      await page.getByTestId('terminal-history-close').tap();
      // Normal typing exits the native history view. The receiver explicitly
      // negotiates bracketed paste and reports base64, so escape rendering cannot
      // accidentally hide a corrupt payload and make this assertion pass.
      await command(page,`python3 '${receiver}'`);
      await until(()=>text(page),value=>value.includes('MOBILE_PASTE_READY'),`${platform} paste receiver ready`);
      const pasted='모바일 alpha🙂\nbeta 한글';
      await application.evaluate(({clipboard},value)=>clipboard.writeText(value),pasted);
      await surface.tap();
      await page.keyboard.press('Meta+V');
      const expected=Buffer.from(pasted.replaceAll('\n','\r')).toString('base64');
      await until(()=>text(page),value=>value.replaceAll(/\s/g,'').includes('WIRE_'+expected),`${platform} exact Unicode multiline paste bytes`);
      await page.screenshot({path:join(output,`${platform}-paste.png`)});
      const coding=[];
      if(process.env.PDMUX_NATIVE_INPUT_MOBILE_CLI==='1') {
        for(const cli of ['claude','codex']) {
          await until(()=>text(page),value=>/[%$#>]\s*$/.test(value.trimEnd()),`${platform} shell ready for ${cli}`);
          await new Promise(resolve=>setTimeout(resolve,150));
          const invocation=cli==='claude'
            ? `cd '${resolve('..')}'; claude --settings '{"tui":"fullscreen"}'`
            : `cd '${root}'; command codex --sandbox read-only`;
          await command(page,invocation);
          await until(()=>state.screen?.alternate,Boolean,`${platform} ${cli} fullscreen`);
          await until(()=>text(page),value=>cli==='claude'?value.includes('Claude Code'):value.includes('Codex'),`${platform} ${cli} ready`);
          await until(()=>state.mouse,Boolean,`${platform} ${cli} mouse protocol ready`);
          await new Promise(resolve=>setTimeout(resolve,150));
          if(cli==='claude') {
            await command(page,'/config');
            await until(()=>text(page),value=>value.includes('Settings'),`${platform} Claude settings`);
          } else {
            await surface.tap(); await page.keyboard.type('/');
          }
          await new Promise(resolve=>setTimeout(resolve,300));
          const before=await text(page), start=state.sent.length;
          await touchDrag(page,surface,cli==='codex'?1:-1,isChromium);
          await until(()=>state.sent.slice(start),frames=>frames.some(frame=>frame.type==='input' && frame.source==='wheel'),`${platform} ${cli} touch reaches application`);
          const after=await text(page);
          if(cli==='claude') assert.notEqual(after,before,'Claude settings respond to touch scroll');
          await page.screenshot({path:join(output,`${platform}-${cli}-scroll.png`)});
          await surface.tap(); await page.keyboard.press('Escape');
          if(cli==='codex') await page.keyboard.press('Control+U');
          await page.locator('[data-pdmux-history]').tap();
          await history.waitFor();
          await until(()=>history.locator('[data-pdmux-history-note="screen"]').count(),value=>value===1,`${platform} ${cli} current program screen`);
          const copiedLine=(await history.locator('[data-pdmux-history-body]').innerText()).split('\n').map(line=>line.trim()).find(line=>line.length>8);
          assert.ok(copiedLine);
          await page.getByTestId('terminal-history-copy').tap();
          await until(()=>application.evaluate(({clipboard})=>clipboard.readText()),value=>value.includes(copiedLine)&&!value.includes('\x1b'),`${platform} ${cli} plain-text copy`);
          await history.screenshot({path:join(output,`${platform}-${cli}-copy.png`)});
          await page.getByTestId('terminal-history-close').tap();
          const payload=`${cli.toUpperCase()}_MOBILE 한글🙂\nsecond line`, pasteStart=state.sent.length;
          await application.evaluate(({clipboard},value)=>clipboard.writeText(value),payload);
          await surface.tap(); await page.keyboard.press('Meta+V');
          await until(()=>state.sent.slice(pasteStart).filter(frame=>frame.type==='input').map(frame=>frame.data).join(''),value=>value.includes(payload.replaceAll('\n','\r')),`${platform} ${cli} multiline paste input`);
          await until(()=>text(page),value=>value.includes(`${cli.toUpperCase()}_MOBILE`),`${platform} ${cli} pasted prompt`);
          await page.screenshot({path:join(output,`${platform}-${cli}-paste.png`)});
          const composed=` COMPOSER_${cli.toUpperCase()} 한글🙂`, composerStart=state.sent.length;
          await application.evaluate(({clipboard},value)=>clipboard.writeText(value),composed);
          await composer.tap(); await page.keyboard.press('Meta+V');
          await until(()=>composer.inputValue(),value=>value===composed,`${platform} ${cli} clipboard reaches composer`);
          await page.getByTestId('terminal-composer-put').tap();
          await until(()=>state.sent.slice(composerStart).filter(frame=>frame.type==='input'),frames=>frames.some(frame=>frame.data===composed),`${platform} ${cli} composer sends without submitting`);
          // Clear the draft before exiting; never submit a validation prompt.
          // The mobile Esc helper both clears application-owned selection and
          // returns focus from the composer without selecting another word.
          await page.getByTestId('terminal-key-esc').tap();
          const exitStart=state.sent.length;
          await page.keyboard.press('Control+C'); await new Promise(resolve=>setTimeout(resolve,600));
          if(cli==='claude') await command(page,'/exit'); else await page.keyboard.press('Control+D');
          await new Promise(resolve=>setTimeout(resolve,400));
          await writeFile(join(output,`${platform}-${cli}-exit.json`),JSON.stringify({inputs:state.sent.slice(exitStart),text:await text(page),active:await page.evaluate(()=>({tag:document.activeElement?.tagName,className:document.activeElement?.className}))},null,2));
          await until(()=>state.screen?.alternate,value=>value===false,`${platform} ${cli} restores shell`);
          await until(()=>text(page),value=>/[%$#>]\s*$/.test(value.trimEnd()),`${platform} shell prompt after ${cli}`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await touchDrag(page,surface,-1,isChromium);
          await command(page,`printf '%s%s\\n' 'AFTER_${cli.toUpperCase()}_' 'MOBILE_OK'`);
          await until(()=>text(page),value=>value.includes(`AFTER_${cli.toUpperCase()}_MOBILE_OK`),`${platform} ${cli} shell input`);
          assert.ok(!(await text(page)).includes('^[[B')&&!(await text(page)).includes('^[[I'));
          coding.push({cli,touchInput:true,scrollChangesScreen:after!==before,historyCopy:true,multilinePaste:true,composerPaste:true,exitClean:true});
        }
      }
      results.push({platform,emulated:true,touch:isChromium?'trusted CDP':'synthetic JS routing',deviceState,tabsBox,dashboardTabs:true,tabSwitchPreservesTerminal:true,shellHistory:true,historyCopy:true,multilinePaste:true,composerPaste:true,geometry,coding,physicalSelection:'requires device'});
      await writeFile(join(output,`${platform}-result.json`),JSON.stringify(results.at(-1),null,2));
      await page.goto('about:blank');
      await save(saved.payload);
      await context.close();
      if(safari){await safari.close();safari=undefined;}
    }
  } finally {
    await safari?.close();
    await application.evaluate(({clipboard},value)=>clipboard.writeText(value),savedClipboard);
  }
  await writeFile(join(output,'result.json'),JSON.stringify({result:'passed',results,physicalDeviceTested:false},null,2));
  return results;
}
