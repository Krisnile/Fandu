import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {Sources} from '../lib/sources.mjs';
import {entry,preferences} from '../src/model.js';
import {pollAsync} from './qa-poll.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-command-recovery-')),sources=new Sources();sources.search=async()=>({state:'ok',results:[]});sources.season=async()=>({state:'ok',results:[],source:'yuc'});
const server=makeServer({dataDir:join(output,'data'),sources});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'},payloads=[],errors=[],scenarios=[];
const read=async()=>{const response=await fetch(base+'/api/library',{headers});assert.equal(response.status,200);return response.json();};
const changed=check=>pollAsync(async()=>check(await read()));
const browserOptions={headless:true,channel:'chrome',viewport:{width:1280,height:850}};
let context,page,mode='',unavailable=false;
try{
  context=await chromium.launchPersistentContext(join(output,'profile'),browserOptions);
  const newPage=async({broken=false}={})=>{
    page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.emulateMedia({reducedMotion:'reduce'});
    await page.route('**/api/source-icon?**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'}));
    await page.route('**/api/library/save',async route=>{payloads.push(route.request().postDataJSON());if(mode==='reject')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试写入拒绝"}'});if(mode==='absent')return route.abort('failed');if(mode==='lost'){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}return route.continue();});
    await page.route('**/api/library/save-status?**',route=>unavailable?route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试核对不可用"}'}):route.continue());
    await page.goto(base);if(broken)await page.locator('#inspectRecoveryLoad').waitFor();else await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);return page;
  };
  const journal=async(action='read',data=null)=>page.evaluate(async({action,data})=>{
    const info=await(await fetch('/api/app-info',{headers:{'X-Yingjian':'1'}})).json(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(info.dataDirectory)),name='fandu-edit-recovery-v1-'+[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    const {createEditRecovery}=await import('/src/edit-recovery.js'),store=createEditRecovery({name});
    try{
      if(action==='read')return await store.read();if(action==='inspect')return await store.inspect();
      if(action==='seed')return await store.writeDraft({id:crypto.randomUUID(),version:crypto.randomUUID(),kind:'note',target:'manual:qa',label:'健康笔记',value:{value:'健康草稿保持原样'},updatedAt:new Date().toISOString()});
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      try{await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite',{durability:'strict'}),records=tx.objectStore('records');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);if(action==='raw')for(const value of data)records.put(value);if(action==='clear')records.clear();});}finally{db.close();}
    }finally{store.close();}
  },{action,data});
  const seed=async()=>{const library=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries:[entry({id:'manual:qa',title:'星海巡航',type:'anime',status:'watching',total:14,progress:4,note:'原有笔记'})],settings:preferences({lists:[...preferences().lists,{id:'list-weekend',label:'周末',kind:'custom'}],series:[{id:'series-old',label:'旧系列'}]})})})).status,200);};
  const settings=async tab=>{await page.locator('#openSettings').click();await page.locator(`[data-settings-tab=${tab}]`).click();};
  const menu=async()=>{if(!await page.locator('#entryRecoveryMenu').evaluate(node=>node.open))await page.locator('#entryRecoverySummary').click();};
  const pending=()=>page.locator('#toasts .toast[data-persistent=true]');
  // A queued command must survive closing before its save starts.
  await seed();await newPage();await settings('list');mode='absent';unavailable=true;
  await page.locator('[data-list-label=watching]').fill('正在追更');await pending().waitFor();
  await page.locator('#newListName').fill('排队的新列表');await page.locator('#addList').click();await pollAsync(async()=>(await journal()).some(item=>item.kind==='command'&&item.value.command.type==='create-list'));
  const queued=(await journal()).find(item=>item.kind==='command'),firstIntent=payloads.at(-1);await page.close();mode='';unavailable=false;await newPage();
  await pollAsync(async()=>!(await journal()).some(item=>item.kind==='intent'));assert.ok(payloads.some(item=>item.requestId===firstIntent.requestId));await menu();await page.locator(`[data-resume-edit="${queued.id}"]`).click();
  await changed(library=>library.settings.lists.some(item=>item.id===queued.value.command.id&&item.label==='排队的新列表'));await pollAsync(async()=>!(await journal()).some(item=>item.kind==='command'));await journal('clear');await page.close();scenarios.push('queued create survives closing before transmission, uses the same object identity and is cleared on confirmation');
  // A committed relative action must never be re-run after restarting.
  await seed();await newPage();mode='lost';unavailable=true;await page.locator('[data-view=watching]').click();await page.locator('.poster-open[data-open="manual:qa"]').hover();await page.locator('[data-progress-add="manual:qa"]').click();await pending().waitFor();
  assert.equal((await read()).entries[0].progress,5);const increment=payloads.at(-1),bound=(await journal()).find(item=>item.kind==='command');assert.equal(bound.value.binding.requestId,increment.requestId);
  await page.close();await context.close();context=await chromium.launchPersistentContext(join(output,'profile'),browserOptions);mode='';unavailable=false;await newPage();await pollAsync(async()=>(await journal()).length===0);assert.equal((await read()).entries[0].progress,5);assert.deepEqual(payloads.at(-1),increment);await page.close();scenarios.push('lost +1 response is confirmed after a real browser restart without incrementing a second time');
  // Known rejection keeps a creation ID while leaving the normal field usable.
  await seed();await newPage();await settings('series');mode='reject';await page.locator('#newSeriesName').fill('失败后重试的系列');await page.locator('#addSeries').click();await page.waitForFunction(()=>!document.querySelector('#addSeries').disabled);const failed=(await journal()).find(item=>item.kind==='command');assert.ok(failed);assert.equal(failed.value.binding,undefined);const stableId=failed.value.command.id;
  mode='';await page.locator('#addSeries').click();await changed(library=>library.settings.series.some(item=>item.id===stableId&&item.label==='失败后重试的系列'));await pollAsync(async()=>(await journal()).length===0);await page.close();scenarios.push('known creation rejection unbinds its save and reuses the same object ID on a normal inline retry');
  // Exercise the actual browser transaction: selective clear and binding guards.
  await seed();await newPage();const checks=await page.evaluate(async()=>{
    const {createEditRecovery}=await import('/src/edit-recovery.js'),{entry,preferences}=await import('/src/model.js'),{librarySaveFingerprint}=await import('/src/library-save.js'),name='fandu-commands-qa-'+crypto.randomUUID(),store=createEditRecovery({name}),check=(ok,message)=>{if(!ok)throw Error(message);};
    const command={id:crypto.randomUUID(),version:crypto.randomUUID(),kind:'command',target:'create-list',label:'创建列表',value:{command:{type:'create-list',id:'list-stable',label:'固定列表'}},updatedAt:new Date().toISOString()};
    await store.writeDraft(command);const payload={requestId:crypto.randomUUID(),revision:0,entries:[entry({id:'manual:one',title:'测试作品',type:'anime'})],settings:preferences()};await store.prepare(payload,[{id:command.id,version:command.version}]);
    let refused=false;try{await store.forgetDraft(command.id,command.version);}catch{refused=true;}check(refused,'bound command cannot be discarded');check((await store.read()).find(item=>item.kind==='command').value.binding.fingerprint===await librarySaveFingerprint(payload),'binding fingerprint');
    await store.forgetIntent(payload,{state:'rejected'});check(!(await store.read())[0].value.binding,'rejection unbinds');await store.prepare(payload,[{id:command.id,version:command.version}]);await store.forgetIntent(payload,{state:'completed'});check((await store.read()).length===0,'completion clears intent and command together');store.close();return {atomicCompletion:true,rejectionUnbinds:true,boundDiscardGuard:true};
  });
  assert.deepEqual(checks,{atomicCompletion:true,rejectionUnbinds:true,boundDiscardGuard:true});
  // Bad browser-local recovery is distinguished from a healthy formal archive.
  const healthy=await journal('seed'),bad={...healthy,id:crypto.randomUUID(),version:crypto.randomUUID(),value:{value:17}};bad.key='draft:'+bad.id;await journal('raw',[bad]);const unchanged=await read();await page.close();await newPage({broken:true});assert.deepEqual(await read(),unchanged);await page.setViewportSize({width:320,height:740});await page.locator('#inspectRecoveryLoad').click();await page.locator('#discardBrokenEdits').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const download=page.waitForEvent('download');await page.locator('#exportEditRecovery').click();const exported=await download,diagnostic=JSON.parse(await readFile(await exported.path(),'utf8'));assert.equal(diagnostic.records.find(item=>item.id===bad.id).value.value,17);assert.equal(diagnostic.records.find(item=>item.id===healthy.id).value.value,'健康草稿保持原样');
  const changedHealthy={...healthy,value:{value:'另一窗口后来的草稿'}};await journal('raw',[changedHealthy]);await page.locator('#discardBrokenEdits').click();await page.waitForFunction(()=>document.querySelector('#editRecoveryRepairState').textContent.includes('记录已变化'));assert.equal((await journal('inspect')).broken.length,1);
  await page.locator('#inspectEditRecovery').click();await page.locator('#discardBrokenEdits').click();await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);assert.deepEqual(await read(),unchanged);const retained=await journal();assert.equal(retained.length,1);assert.equal(retained[0].value.value,'另一窗口后来的草稿');assert.equal(retained[0].id,healthy.id);await journal('clear');await page.close();scenarios.push('320px corruption recovery exports raw data, refuses a stale clear and preserves healthy edits and the formal archive');
  // A future record is never treated as disposable corruption.
  await newPage();const future=await journal('seed');future.format=99;await journal('raw',[future,bad]);await page.close();await newPage({broken:true});await page.locator('#inspectRecoveryLoad').click();await page.locator('#discardBrokenEdits').click();await page.locator('#inspectRecoveryLoad').waitFor();const final=await journal('inspect');assert.equal(final.newer.length,1);assert.equal(final.broken.length,0);assert.equal(final.records[0].id,future.id);assert.equal(await page.locator('#addWork').isDisabled(),true);assert.deepEqual(await read(),unchanged);scenarios.push('selective repair preserves future-version records and keeps writes paused until a compatible version is used');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,scenarios,checks}));
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));}
