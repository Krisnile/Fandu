import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {Sources} from '../lib/sources.mjs';
import {entry} from '../src/model.js';
import {pollAsync} from './qa-poll.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-edit-recovery-')),sources=new Sources();sources.search=async()=>({state:'ok',results:[]});sources.season=async()=>({state:'ok',results:[],source:'yuc'});
const server=makeServer({dataDir:join(output,'data'),sources});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
const read=async()=>{const response=await fetch(base+'/api/library',{headers});assert.equal(response.status,200);return response.json();};
const changed=check=>pollAsync(async()=>check(await read()));
let browser;
try{
  const browserOptions={headless:true,channel:'chrome',viewport:{width:1280,height:850}};
  let context=await chromium.launchPersistentContext(join(output,'profile'),browserOptions);browser=context;
  const errors=[],payloads=[],scenarios=[];
  let page,sendMode='',confirmUnavailable=false;
  const newPage=async({loadFailure=false}={})=>{
    page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.emulateMedia({reducedMotion:'reduce'});
    await page.route('**/api/source-icon?**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'}));
    let rejectInitialRead=loadFailure;await page.route('**/api/library',route=>{if(rejectInitialRead&&route.request().method()==='GET'){rejectInitialRead=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试首次读档失败"}'});}return route.continue();});
    await page.route('**/api/library/save',async route=>{payloads.push(route.request().postDataJSON());if(sendMode==='reject')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试保存暂不可用"}'});if(sendMode==='absent')return route.abort('failed');if(sendMode==='lost'){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}return route.continue();});
    await page.route('**/api/library/save-status?**',route=>confirmUnavailable?route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试核对暂不可用"}'}):route.continue());
    await page.goto(base);if(loadFailure)await page.locator('#openRecovery').waitFor();else await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);return page;
  };
  const records=()=>page.evaluate(async()=>{
    const info=await(await fetch('/api/app-info',{headers:{'X-Yingjian':'1'}})).json(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(info.dataDirectory));
    const name='fandu-edit-recovery-v1-'+[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join(''),{createEditRecovery}=await import('/src/edit-recovery.js'),store=createEditRecovery({name});
    try{return await store.read();}finally{store.close();}
  });
  const seed=async()=>{const library=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries:[entry({id:'manual:recovery',title:'星海巡航',type:'anime',status:'completed',total:12,progress:12,note:'原有笔记'})],settings:{...library.settings,theme:'blue',mode:'dark',accent:''}})})).status,200);};
  const open=async()=>{await page.locator('[data-view=completed]').click();await page.locator('.poster-open[data-open="manual:recovery"]').click();await page.locator('#noteInput').waitFor();};
  const menu=async()=>{if(!await page.locator('#entryRecoveryMenu').evaluate(el=>el.open))await page.locator('#entryRecoverySummary').click();};
  const pending=()=>page.locator('#toasts .toast[data-persistent=true]');

  await seed();await newPage();await open();sendMode='lost';confirmUnavailable=true;await page.locator('#noteInput').fill('已提交的第一条笔记');await pending().waitFor();
  await page.locator('#noteInput').fill('异常退出前继续输入的笔记');await page.locator('[data-rating="5"]').click();
  await pollAsync(async()=>{const saved=await records();return saved.some(item=>item.kind==='note'&&item.value.value==='异常退出前继续输入的笔记')&&saved.some(item=>item.kind==='fields'&&item.value.patch.rating===5)&&saved.some(item=>item.kind==='intent');});
  const original=payloads[0];await page.close();await context.close();context=await chromium.launchPersistentContext(join(output,'profile'),browserOptions);browser=context;await newPage();await pending().waitFor();assert.deepEqual(payloads[1],original);sendMode='';confirmUnavailable=false;await pending().locator('.toast-action').click();await pending().waitFor({state:'hidden'});assert.deepEqual(payloads[2],original);
  const drafts=(await records()).filter(item=>item.kind!=='intent');assert.equal(drafts.length,2);await menu();await page.screenshot({path:join(output,'reopened-drafts-desktop.png')});
  await page.locator(`[data-resume-edit="${drafts.find(item=>item.kind==='note').id}"]`).click();await changed(library=>library.entries[0].note==='异常退出前继续输入的笔记');await page.waitForFunction(()=>document.querySelector('#noteSaveState').textContent==='已保存');await page.locator('#closeDrawer').click();await menu();await page.locator(`[data-resume-edit="${drafts.find(item=>item.kind==='fields').id}"]`).click();await changed(library=>library.entries[0].rating===5);await pollAsync(async()=>(await records()).length===0);await page.close();scenarios.push('restarted browser resumes the identical pending request, then restores later note and queued rating separately');

  await seed();await newPage();await open();await page.locator('#editEntry').click();await page.locator('#entryForm [name=title]').fill('');await page.locator('#entryForm [name=total]').fill('17');await page.waitForFunction(()=>document.querySelector('#entrySaveState').textContent.includes('必填'));await pollAsync(async()=>(await records()).some(item=>item.kind==='form'&&item.value.values.title===''&&item.value.values.total==='17'));await page.close();
  let library=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries:library.entries.map(item=>({...item,note:'另一窗口后来的笔记'}))})})).status,200);
  await newPage();const form=(await records()).find(item=>item.kind==='form');await menu();await page.locator(`[data-resume-edit="${form.id}"]`).click();await page.waitForFunction(()=>document.querySelector('#entryForm [name=total]').value==='17');assert.equal(await page.locator('#entryForm [name=title]').inputValue(),'');assert.equal(await page.locator('#entryForm [name=total]').inputValue(),'17');await page.locator('#entryForm [name=title]').fill('恢复后的星海巡航');await changed(library=>library.entries[0].title==='恢复后的星海巡航'&&library.entries[0].total===17&&library.entries[0].note==='另一窗口后来的笔记');await pollAsync(async()=>(await records()).length===0);await page.close();scenarios.push('invalid unsent form survives reopening and restores only touched fields');

  await seed();await newPage();await page.locator('#openSettings').click();sendMode='absent';await page.locator('.theme-swatch[data-choice=amber]').click();await pending().waitFor();await page.locator('#modeToggle').click();await page.locator('#accentColor').fill('#27a478');await pollAsync(async()=>(await records()).some(item=>item.kind==='settings'&&item.value.accent==='#27a478'&&item.value.mode==='light'));const themeIntent=payloads.at(-1);await page.close();sendMode='';await newPage();await pollAsync(async()=>!(await records()).some(item=>item.kind==='intent'));assert.ok(payloads.some(value=>value.requestId===themeIntent.requestId));const settings=(await records()).find(item=>item.kind==='settings');await menu();await page.locator(`[data-resume-edit="${settings.id}"]`).click();await changed(library=>library.settings.theme==='amber'&&library.settings.mode==='light'&&library.settings.accent==='#27a478');await pollAsync(async()=>(await records()).length===0);await page.close();scenarios.push('unreceived theme intent and later color/mode preview survive reopening without a new identity');

  await seed();await newPage();await page.locator('#openSettings').click();await page.locator('[data-settings-tab=list]').click();sendMode='reject';await page.locator('[data-list-label=watching]').fill('关页前的追更名称');await page.locator('[data-retry-manager-name="list:watching"]').waitFor();await pollAsync(async()=>(await records()).some(item=>item.kind==='manager'));await page.close();sendMode='';await newPage();const manager=(await records()).find(item=>item.kind==='manager');await menu();await page.locator(`[data-resume-edit="${manager.id}"]`).click();await changed(library=>library.settings.lists.find(item=>item.id==='watching').label==='关页前的追更名称');await pollAsync(async()=>(await records()).length===0);await page.close();scenarios.push('failed list-name draft survives closing and resumes in the existing setting field');

  await seed();await newPage();await open();sendMode='reject';await page.locator('#noteInput').fill('已删除作品仍可导出的笔记');await page.locator('#retryNote').waitFor();await pollAsync(async()=>(await records()).some(item=>item.kind==='note'));await page.close();library=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries:[]})})).status,200);sendMode='';await newPage();const orphan=(await records()).find(item=>item.kind==='note');await page.setViewportSize({width:320,height:740});await menu();await page.locator(`[data-resume-edit="${orphan.id}"]`).click();await page.locator('#toasts .toast').filter({hasText:'作品已不在收藏中'}).waitFor();assert.deepEqual((await read()).entries,[]);await page.screenshot({path:join(output,'orphan-draft-320.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const download=page.waitForEvent('download');await page.locator(`[data-export-edit="${orphan.id}"]`).click();const exported=await download;assert.equal(JSON.parse(await readFile(await exported.path(),'utf8')).value.value,'已删除作品仍可导出的笔记');await page.locator(`[data-ask-discard-edit="${orphan.id}"]`).click();await page.locator(`[data-discard-edit="${orphan.id}"]`).click();assert.equal((await records()).length,0);scenarios.push('deleted work is never recreated; 320px recovery keeps export and explicit discard usable');
  await page.close();await seed();const catalog=await(await fetch(base+'/api/backups/create',{method:'POST',headers,body:'{}'})).json(),snapshot=catalog.backups.find(item=>item.kind==='manual');assert.ok(snapshot);library=await read();assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,entries:[]})})).status,200);
  await newPage({loadFailure:true});await page.locator('#openRecovery').click();const snapshotRow=page.locator(`[data-backup-row="${snapshot.id}"]`);await snapshotRow.locator('[data-restore-backup]').click();await snapshotRow.locator('[data-confirm-restore-backup]').click();await changed(library=>library.entries.length===1);await page.locator('#dataDialog .close-btn').click();await open();await page.locator('#noteInput').fill('恢复档案后仍可自动保存');await changed(library=>library.entries[0].note==='恢复档案后仍可自动保存');await pollAsync(async()=>(await records()).length===0);scenarios.push('restoring after an initial load failure initializes editing recovery before subsequent autosave');
  const journalChecks=await page.evaluate(async()=>{
    const {createEditRecovery,EDIT_RECOVERY_LIMITS}=await import('/src/edit-recovery.js'),store=createEditRecovery({name:'fandu-qa-journal-'+crypto.randomUUID()}),id=crypto.randomUUID(),version=crypto.randomUUID();
    const value={id,version,kind:'note',target:'test',label:'测试草稿',value:{value:'第一份输入'},updatedAt:new Date().toISOString()};
    const check=(ok,message)=>{if(!ok)throw Error(message);};
    await store.writeDraft(value);let failed=false;try{await store.writeDraft({...value,version:crypto.randomUUID()},crypto.randomUUID());}catch{failed=true;}check(failed,'wrong CAS must fail');check((await store.read())[0].version===version,'conflict must retain original');check(await store.forgetDraft(id,crypto.randomUUID())===false,'stale discard must fail');await store.forgetDraft(id,version);
    failed=false;try{await store.writeDraft({...value,version:crypto.randomUUID()},version);}catch{failed=true;}check(failed,'closed draft must not resurrect');
    for(let index=0;index<EDIT_RECOVERY_LIMITS.drafts;index++)await store.writeDraft({...value,id:crypto.randomUUID(),version:crypto.randomUUID()});
    failed=false;try{await store.writeDraft({...value,id:crypto.randomUUID(),version:crypto.randomUUID()});}catch{failed=true;}check(failed,'capacity must not evict');check((await store.read()).length===EDIT_RECOVERY_LIMITS.drafts,'capacity must retain every draft');store.close();return {cas:true,noResurrection:true,capacity:true};
  });
  assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify({scenarios,errors,journalChecks},null,2));console.log(JSON.stringify({passed:true,output,scenarios,journalChecks}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
