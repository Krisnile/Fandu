import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {Sources} from '../lib/sources.mjs';
import {entry} from '../src/model.js';
import {pollAsync} from './qa-poll.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-save-recovery-')),sources=new Sources();
sources.search=async()=>({state:'ok',results:[]});sources.season=async()=>({state:'ok',results:[],source:'yuc'});
const server=makeServer({dataDir:join(output,'data'),sources});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
const read=async()=>{const response=await fetch(base+'/api/library',{headers});assert.equal(response.status,200);return response.json();};
const changed=check=>pollAsync(async()=>check(await read()));
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);await page.emulateMedia({reducedMotion:'reduce'});
  const errors=[],scenarios=[],payloads=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/source-icon?**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'}));
  let sendMode='',confirmUnavailable=false;
  await page.route('**/api/library/save',async route=>{
    payloads.push(route.request().postDataJSON());
    if(sendMode==='reject')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试写入拒绝"}'});
    if(sendMode==='absent')return route.abort('failed');
    if(sendMode==='lost'){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}
    return route.continue();
  });
  await page.route('**/api/library/save-status?**',route=>confirmUnavailable?route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试核对暂不可用"}'}):route.continue());
  const seed=async()=>{
    const library=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries:[entry({id:'manual:save',title:'星海巡航',type:'anime',status:'completed',total:12,progress:12,note:'原有笔记'})],settings:{...library.settings,theme:'blue',mode:'dark',accent:''}})})).status,200);
    await page.goto(base);await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);payloads.length=0;
  };
  const open=async()=>{await page.locator('[data-view=completed]').click();await page.locator('.poster-open[data-open="manual:save"]').click();await page.locator('#noteInput').waitFor();};
  const recovery=page.locator('#toasts .toast[data-persistent=true]'),button=recovery.locator('.toast-action');
  const settled=async()=>{await recovery.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#noteSaveState')?.textContent==='已保存');};
  await seed();await open();sendMode='lost';await page.locator('#noteInput').fill('已写入但响应丢失');await changed(library=>library.entries[0].note==='已写入但响应丢失');await settled();assert.equal(payloads.length,1);scenarios.push('ordinary note confirms a lost response without a second save');

  sendMode='';await seed();await open();sendMode='lost';confirmUnavailable=true;
  await page.locator('#noteInput').fill('第一次固定意图');await recovery.waitFor();assert.equal(await page.locator('#noteSaveState').textContent(),'待核对');assert.equal(await recovery.locator('.toast-dismiss').isVisible(),false);
  await page.locator('#noteInput').fill('等待期间继续输入的笔记');await page.locator('[data-rating="5"]').click();
  await page.screenshot({path:join(output,'detail-pending.png')});assert.equal(payloads.length,1);
  // The first exact request completed, then another window changed progress.
  let latest=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...latest,entries:latest.entries.map(item=>({...item,progress:9,status:'watching'}))})})).status,200);
  sendMode='';confirmUnavailable=false;await button.click();await changed(library=>library.entries[0].note==='等待期间继续输入的笔记'&&library.entries[0].rating===5&&library.entries[0].progress===9);await settled();assert.deepEqual(payloads[0],payloads[1]);assert.equal(await page.locator('#noteInput').inputValue(),'等待期间继续输入的笔记');scenarios.push('fixed-intent recovery drains queued rating and newer notes, retaining another window’s progress');

  await seed();await open();sendMode='lost';confirmUnavailable=true;await page.locator('#noteInput').fill('本窗口完成的笔记');await recovery.waitFor();latest=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...latest,entries:latest.entries.map(item=>({...item,note:'后来由另一窗口修改的笔记'}))})})).status,200);
  sendMode='';confirmUnavailable=false;await button.click();await settled();assert.equal(await page.locator('#noteInput').inputValue(),'后来由另一窗口修改的笔记');assert.equal((await read()).entries[0].note,'后来由另一窗口修改的笔记');scenarios.push('completed receipt adopts newer same-field contents without reapplying an old note');

  await seed();await open();const before=(await read()).revision;sendMode='absent';await page.locator('#noteInput').fill('原请求未抵达');await recovery.waitFor();assert.equal((await read()).revision,before);assert.equal(await page.locator('#noteSaveState').textContent(),'待核对');sendMode='';await button.click();await settled();assert.deepEqual(payloads[0],payloads[1]);assert.equal((await read()).revision,before+1);scenarios.push('unknown transport result retries the same request instead of rebasing it');

  await seed();await open();sendMode='reject';await page.locator('#noteInput').fill('真正拒绝后重试');await page.locator('#retryNote').waitFor();assert.equal(await recovery.count(),0);sendMode='';await page.locator('#retryNote').click();await settled();assert.notEqual(payloads[0].requestId,payloads[1].requestId);scenarios.push('definitely unpublished failure uses the existing field retry');

  await seed();await open();latest=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...latest,entries:latest.entries.map(item=>({...item,rating:4}))})})).status,200);
  await page.locator('#noteInput').fill('版本冲突后的本地输入');await page.locator('#retryNote').waitFor();assert.equal(await recovery.count(),0);await page.locator('#retryNote').click();await settled();latest=await read();assert.equal(latest.entries[0].rating,4);assert.equal(latest.entries[0].note,'版本冲突后的本地输入');assert.notEqual(payloads[0].requestId,payloads[1].requestId);assert.ok(payloads[1].revision>payloads[0].revision);scenarios.push('definite version conflict reads latest data for a new edit, preserving independent changes');

  await seed();await open();await page.locator('#editEntry').click();sendMode='lost';confirmUnavailable=true;
  await page.locator('#entryForm [name=title]').fill('等待确认的标题');await recovery.waitFor();assert.equal(await page.locator('#entrySaveState').textContent(),'待核对');
  await page.locator('#entryForm [name=title]').fill('星海巡航');latest=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...latest,entries:latest.entries.map(item=>({...item,note:'另一窗口更新的笔记',progress:7,status:'watching'}))})})).status,200);
  sendMode='';confirmUnavailable=false;await button.click();await page.waitForFunction(()=>document.querySelector('#entrySaveState').textContent==='已保存');latest=await read();assert.equal(latest.entries[0].title,'星海巡航');assert.equal(latest.entries[0].note,'另一窗口更新的笔记');assert.equal(latest.entries[0].progress,7);assert.deepEqual(payloads[0],payloads[1]);await page.locator('#entryForm .close-btn').click();await page.locator('#entryDialog').waitFor({state:'hidden'});scenarios.push('edited fields only merge into the latest work, including reverting a title while confirmation waits');

  await seed();await page.locator('#openSettings').click();await page.locator('[data-settings-tab=list]').click();sendMode='lost';confirmUnavailable=true;
  await page.locator('[data-list-label=watching]').fill('待确认的列表名称');await recovery.waitFor();await page.locator('[data-list-label=watching]').fill('实时追更');sendMode='';confirmUnavailable=false;await button.click();await changed(library=>library.settings.lists.find(item=>item.id==='watching')?.label==='实时追更');await recovery.waitFor({state:'hidden'});assert.deepEqual(payloads[0],payloads[1]);await page.waitForFunction(()=>document.querySelector('[data-manager-name="list:watching"] .manager-name-feedback')?.hidden);scenarios.push('list-name autosave keeps newer input and its original confirmation in the same queue');

  await seed();await page.locator('#openSettings').click();await page.locator('[data-settings-tab=general]').click();sendMode='lost';confirmUnavailable=true;
  await page.locator('.theme-swatch[data-choice=amber]').click();await recovery.waitFor();assert.equal(await page.locator('#generalSaveState').textContent(),'待核对');
  await page.locator('#modeToggle').click();await page.locator('#accentColor').fill('#3aab73');assert.equal(await page.locator('html').getAttribute('data-mode'),'light');assert.equal(payloads.length,1);
  await page.setViewportSize({width:320,height:740});await button.focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('#dataDialog'))),true);
  await page.screenshot({path:join(output,'settings-pending-320-light.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.locator('[data-settings-tab=data]').click();assert.equal(await page.locator('#importData').isDisabled(),true);assert.equal(await page.locator('#createSnapshot').isDisabled(),true);
  sendMode='';confirmUnavailable=false;await button.click();await changed(library=>library.settings.theme==='amber'&&library.settings.mode==='light'&&library.settings.accent==='#3aab73');await recovery.waitFor({state:'hidden'});assert.deepEqual(payloads[0],payloads[1]);scenarios.push('theme preview continues while pending; keyboard recovery stays in the 320px panel and destructive data operations wait');

  await page.setViewportSize({width:1280,height:850});await seed();await open();sendMode='lost';confirmUnavailable=true;await page.locator('#restartEntry').click();await recovery.waitFor();sendMode='';confirmUnavailable=false;await button.click();const undo=page.locator('#toasts .toast').filter({hasText:'已从头'}).locator('.toast-action');await undo.waitFor();await undo.click();await changed(library=>library.entries[0].progress===12&&library.entries[0].status==='completed');scenarios.push('restart and undo share receipt-backed persistence');
  assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify({scenarios,errors,frontendIntegrated:true},null,2));console.log(JSON.stringify({passed:true,output,scenarios,frontendIntegrated:true}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
