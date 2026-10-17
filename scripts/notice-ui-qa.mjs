import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {Sources} from '../lib/sources.mjs';
import {entry} from '../src/model.js';
import {auditTextContrast} from './text-contrast.mjs';
import {pollAsync} from './qa-poll.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-notice-ui-')),sources=new Sources();
sources.search=async()=>({state:'ok',results:[]});sources.season=async()=>({state:'ok',results:[],source:'yuc'});
const server=makeServer({dataDir:join(output,'data'),sources});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
const fixture=entry({id:'manual:notice',title:'星海巡航',type:'anime',status:'completed',total:12,progress:12,note:'原有笔记'});
const other=entry({id:'manual:other',title:'边界之外',type:'movie',status:'watching',total:1,progress:0});
const read=async()=>{const response=await fetch(base+'/api/library',{headers});assert.equal(response.status,200);return response.json();};
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);await page.emulateMedia({reducedMotion:'reduce'});
  const errors=[],reports=[],scenarios=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/source-icon?**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'}));
  const seed=async(settings={},entries=[fixture,other])=>{const library=await read();const response=await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries,settings:{...library.settings,...settings}})});assert.equal(response.status,200);await page.goto(base);await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);};
  const open=async(id=fixture.id)=>{await page.locator(`[data-open="${id}"]:visible`).first().click();await page.locator('#noteInput').waitFor();};
  const notice=text=>page.locator('#toasts .toast').filter({hasText:text});
  const action=text=>notice(text).locator('.toast-action');
  const capture=async(name,scope='#toasts')=>{const report=await page.evaluate(auditTextContrast,scope);reports.push({name,...report});assert.equal(report.failures.length,0,name+' contrast');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' width');await page.screenshot({path:join(output,name+'.png')});};
  const separated=async(a,b)=>assert.equal(await page.evaluate(([a,b])=>{const x=document.querySelector(a).getBoundingClientRect(),y=document.querySelector(b).getBoundingClientRect();return x.width>0&&x.height>0&&y.width>0&&y.height>0&&(x.bottom<=y.top||y.bottom<=x.top||x.right<=y.left||y.right<=x.left);},[a,b]),true,`${a} must not cover ${b}`);
  const changed=async(predicate)=>pollAsync(async()=>predicate(await read()));
  await seed();await page.clock.install();await open();await page.locator('#restartEntry').click();await action('已从头').waitFor();
  assert.equal(await page.locator('#detailNoticeSlot #toasts').count(),1);await separated('#toasts','#drawerContent');
  await page.locator('#closeDrawer').focus();await page.keyboard.press('Tab');assert.equal(await action('已从头').evaluate(node=>node===document.activeElement),true);
  await page.mouse.move(0,0);await page.clock.fastForward(13000);assert.equal(await action('已从头').isVisible(),true);await page.keyboard.press('Enter');await changed(library=>library.entries.find(item=>item.id===fixture.id)?.progress===12);scenarios.push('detail undo is in keyboard scope and focused countdown pauses');
  // A known write failure leaves the original undo available, without an
  // unhandled promise rejection or another stacked error notice.
  await page.locator('#restartEntry').click();let reject=true;
  await page.route('**/api/library{,/save}',route=>route.request().method()==='POST'&&reject?route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试磁盘暂不可用"}'}):route.continue());
  await action('已从头').click();await notice('已从头').locator('.toast-error').waitFor();assert.match(await notice('已从头').textContent(),/测试磁盘/);assert.equal(await action('已从头').textContent(),'重试撤销');await capture('retry-undo-detail');
  reject=false;await action('已从头').click();await changed(library=>library.entries.find(item=>item.id===fixture.id)?.progress===12);await page.unroute('**/api/library{,/save}');scenarios.push('failed undo retains original action and retries once');
  await page.locator('#restartEntry').click();await page.locator('#progressRange').fill('3');await page.locator('#progressRange').dispatchEvent('change');await changed(library=>library.entries.find(item=>item.id===fixture.id)?.progress===3);await action('已从头').click();await notice('已从头').locator('.toast-error').waitFor();assert.match(await notice('已从头').textContent(),/进度已再次修改/);assert.equal(await action('已从头').isDisabled(),true);assert.equal(await action('已从头').textContent(),'不可撤销');assert.equal((await read()).entries.find(item=>item.id===fixture.id).progress,3);await capture('new-progress-not-overwritten');scenarios.push('late restart undo refuses to overwrite newer progress and offers no misleading retry');
  await seed();await open();await page.locator('#restartEntry').click();await page.locator('#noteInput').fill('重看后新增的笔记');await page.clock.fastForward(1000);await changed(library=>library.entries.find(item=>item.id===fixture.id)?.note==='重看后新增的笔记');await action('已从头').click();await changed(library=>{const item=library.entries.find(item=>item.id===fixture.id);return item?.progress===12&&item.note==='重看后新增的笔记';});scenarios.push('undo changes only progress and status, preserving newer notes');
  // Queue deletion behind an unrelated write; both must resolve against the
  // latest library rather than replaying a snapshot taken at button click.
  let release,started;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve);let held=false;
  await page.route('**/api/library{,/save}',async route=>{if(route.request().method()==='POST'&&!held){held=true;started();await gate;}await route.continue();});
  await page.locator('[data-rating="5"]').click();await began;await page.locator('#removeEntry').click();release();await notice('已移出').waitFor();await page.unroute('**/api/library{,/save}');
  await open(other.id);await page.locator('[data-rating="4"]').click();await changed(library=>library.entries.find(item=>item.id===other.id)?.rating===4);await page.locator('#closeDrawer').click();
  await page.locator('#addWork').click();assert.equal(await page.locator('#entryDialog .notice-slot #toasts').count(),1);await separated('#toasts','#createEntry');await separated('#toasts','#entryForm .form-grid');await capture('undo-in-entry-panel');
  await page.locator('#entryForm .close-btn').focus();await page.keyboard.press('Tab');assert.equal(await action('已移出').evaluate(node=>node===document.activeElement),true);
  const title=page.locator('#entryForm [name=title]');await title.dispatchEvent('compositionstart');assert.equal(await action('已移出').isDisabled(),true);await title.focus();await page.mouse.move(0,0);await page.clock.fastForward(13000);assert.equal(await action('已移出').count(),1);await title.dispatchEvent('compositionend');assert.equal(await action('已移出').isDisabled(),false);
  let undoRelease,undoStarted;const undoGate=new Promise(resolve=>undoRelease=resolve),undoBegan=new Promise(resolve=>undoStarted=resolve);
  await page.route('**/api/library{,/save}',async route=>{if(route.request().method()==='POST'){undoStarted();await undoGate;}await route.continue();});
  await action('已移出').click();await undoBegan;assert.equal(await action('已移出').isDisabled(),true);assert.equal(await notice('已移出').locator('.toast-dismiss').isDisabled(),true);await page.clock.fastForward(10000);assert.equal(await notice('已移出').count(),1);undoRelease();await changed(library=>library.entries.some(item=>item.id===fixture.id));await page.unroute('**/api/library{,/save}');await notice('已移出').waitFor({state:'hidden'});
  let library=await read();assert.equal(library.entries.find(item=>item.id===fixture.id).rating,5);assert.equal(library.entries.find(item=>item.id===other.id).rating,4);assert.equal(library.entries.find(item=>item.id===fixture.id).note,'重看后新增的笔记');scenarios.push('deletion and undo merge queued changes, with non-dismissible single-flight action','IME and busy action pause countdown without hiding editable form');
  await page.locator('#cancelEntry').click();
  library=await read();await seed({lists:[...library.settings.lists,{id:'night',label:'深夜片单',kind:'custom'}],series:[{id:'night',label:'星海系列'}]},[entry({...fixture,lists:['night'],seriesId:'night'}),other]);await open();await page.locator('#removeEntry').click();await notice('已移出').waitFor();await page.locator('#openSettings').click();
  await page.locator('[data-settings-tab="list"]').click();await page.locator('[data-delete-list="night"]').click();await page.locator('[data-confirm-delete-list="night"]').click();await changed(library=>!library.settings.lists.some(item=>item.id==='night'));
  await page.locator('[data-settings-tab="series"]').click();await page.locator('[data-delete-series="night"]').click();await page.locator('[data-confirm-delete-series="night"]').click();await changed(library=>library.settings.series.length===0);
  await action('已移出').click();await changed(library=>library.entries.some(item=>item.id===fixture.id));library=await read();assert.deepEqual(library.entries.find(item=>item.id===fixture.id).lists,[]);assert.equal(library.entries.find(item=>item.id===fixture.id).seriesId,'');await page.locator('#dataDialog .close-btn').click();scenarios.push('restore respects list/series deletion while the notice is open');
  // Real persisted presets, three widths, every active-panel location.
  for(const width of [1280,390,320])for(const mode of ['dark','light'])for(const theme of ['blue','violet','cyan','amber','graphite']){
    await page.setViewportSize({width,height:850});await seed({theme,mode,accent:''});await open();await page.locator('#restartEntry').click();await action('已从头').waitFor();await separated('#toasts','#drawerContent');await capture(`${width}-${mode}-${theme}-detail`);
    await page.locator('#removeEntry').click();await notice('已移出').waitFor();await page.locator('#addWork').click();await separated('#toasts','#createEntry');await capture(`${width}-${mode}-${theme}-entry`);await page.locator('#cancelEntry').click();
    if(width<681){await page.locator('#mobileMenu').click();assert.equal(await page.locator('#navNoticeSlot #toasts').count(),1);await separated('#toasts','#openSettings');await capture(`${width}-${mode}-${theme}-navigation`);}
    await page.locator('#openSettings').click();assert.equal(await page.locator('#dataDialog .notice-slot #toasts').count(),1);await separated('#toasts','.settings-tabs');await capture(`${width}-${mode}-${theme}-settings`);await page.locator('#dataDialog .close-btn').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#toasts').evaluate(region=>region.contains(document.activeElement)),true);await page.locator('#dataDialog .close-btn').click();
    await page.mouse.move(0,0);await page.locator('#addWork').focus();await page.waitForFunction(()=>getComputedStyle(document.querySelector('#toasts')).position==='fixed');await page.clock.fastForward(13000);
    // fastForward deliberately invokes each due timer only once. Let timers
    // scheduled by the first notice's removal execute on the next clock turn.
    // https://playwright.dev/docs/api/class-clock#clock-fast-forward
    await page.clock.runFor(50);assert.equal(await page.locator('#toasts .toast').count(),0,JSON.stringify(await page.locator('#toasts').evaluate(region=>({width:innerWidth,theme:document.documentElement.dataset.theme,mode:document.documentElement.dataset.mode,height:region.clientHeight,scroll:region.scrollHeight,active:document.activeElement.id,hover:region.matches(':hover'),text:region.textContent}))));
  }
  scenarios.push('30 preset/width combinations across detail, form and settings, plus narrow navigation; no overlap, overflow or solid-text contrast failure','unfocused notices expire after returning to collection');
  assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify({reports,scenarios},null,2));console.log(JSON.stringify({passed:true,output,screens:reports.length,scenarios}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
