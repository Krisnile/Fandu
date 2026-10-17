import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {entry} from '../src/model.js';

// This entire workflow owns an isolated fixture; never restore/delete the
// user's archive to test a destructive confirmation.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-snapshot-ui-')),dataDir=join(output,'data');
const server=makeServer({dataDir});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
const json=async(path,options={})=>{
  const response=await fetch(base+path,{headers,...options});assert.equal(response.status,200);return response.json();
};
const initial=await json('/api/library');
await json('/api/library',{method:'PUT',body:JSON.stringify({...initial,entries:[entry({id:'snapshot-ui',title:'星海巡航',type:'anime',note:'snapshot'}),entry({id:'snapshot-ui-2',title:'边界之外',type:'movie'})],settings:{...initial.settings,theme:'cyan',mode:'light'}})});
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.locator('#collectionOverview').waitFor();
  await page.locator('#openSettings').click();await page.locator('[data-settings-tab=data]').click();
  const ready=()=>page.waitForFunction(()=>document.querySelector('#backupState').dataset.busy==='false'&&!document.querySelector('#refreshBackups').disabled);
  await ready();
  const capture=async(name,mobile=false)=>{
    await page.setViewportSize(mobile?{width:390,height:844}:{width:1280,height:850});
    await page.locator('#toasts .toast-dismiss').evaluateAll(nodes=>nodes.forEach(node=>node.click()));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const overflows=await page.locator('#settingsData .backup-row').evaluateAll(rows=>rows.filter(row=>row.scrollWidth>row.clientWidth+1).length);
    assert.equal(overflows,0,'快照卡片不应靠裁切隐藏溢出的操作或错误');
    await page.screenshot({path:join(output,name+'.png')});
  };
  const locked=async(progress)=>{
    assert.equal(await page.locator('#dataDialog button:not(:disabled):not(.toast-dismiss),#dataDialog input:not(:disabled),#dataDialog select:not(:disabled),#dataDialog textarea:not(:disabled)').count(),0);
    await page.keyboard.press('Escape');await page.keyboard.press('Tab');
    assert.equal(await page.locator('#dataDialog').isVisible(),true);
    assert.equal(await page.locator(progress).evaluate(node=>node===document.activeElement),true);
  };
  const requestBodies=[];let releaseCreate;
  const createGate=new Promise(resolve=>{releaseCreate=resolve;});
  await page.route('**/api/backups/create',async route=>{requestBodies.push(route.request().postData());await createGate;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试创建失败"}'});});
  await page.locator('#createSnapshot').click();await page.waitForFunction(()=>document.querySelector('#backupState').textContent.includes('正在创建'));
  await locked('#backupState');await page.evaluate(()=>document.querySelector('#createSnapshot').onclick());
  await capture('snapshot-create-busy');releaseCreate();
  await page.waitForFunction(()=>document.querySelector('#backupState').textContent.includes('测试创建失败')&&!document.querySelector('#createSnapshot').disabled);
  assert.equal(requestBodies.length,1);assert.equal(await page.locator('#createSnapshot').textContent(),'重试创建');
  await capture('snapshot-create-error-mobile',true);
  await page.setViewportSize({width:1280,height:850});
  await page.unroute('**/api/backups/create');
  await page.route('**/api/backups/create',async route=>{
    requestBodies.push(route.request().postData());
    await json('/api/backups/create',{method:'POST',body:route.request().postData()});await route.abort('failed');
  });
  await page.locator('#createSnapshot').click();
  await page.waitForFunction(()=>document.querySelector('#backupState').textContent.includes('创建未确认')&&!document.querySelector('#createSnapshot').disabled);
  assert.equal((await json('/api/backups')).backups.filter(item=>item.kind==='manual').length,1);
  await page.unroute('**/api/backups/create');
  await page.route('**/api/backups/create',route=>{requestBodies.push(route.request().postData());return route.continue();});
  await page.locator('#createSnapshot').click();await ready();
  assert.equal(requestBodies.length,3);assert.equal(new Set(requestBodies).size,1,'创建失败与响应丢失都重试相同编号及字节版本');
  await page.unroute('**/api/backups/create');
  let catalog=await json('/api/backups');const manual=catalog.backups.find(item=>item.kind==='manual');
  const row=page.locator(`[data-backup-row="${manual.id}"]`);
  assert.equal(catalog.backups.filter(item=>item.kind==='manual').length,1);
  // A failed catalogue read retains useful context but disables stale actions.
  const count=await page.locator('#backupList .backup-row').count();
  await page.route('**/api/backups',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试读取失败"}'}));
  await page.locator('#refreshBackups').click();await ready();
  assert.ok((await page.locator('#backupState').textContent()).includes('上次列表仍保留'));
  assert.equal(await page.locator('#backupList .backup-row').count(),count);
  assert.equal(await page.locator('#createSnapshot').isDisabled(),true);assert.equal(await row.locator('[data-restore-backup]').isDisabled(),true);
  await page.unroute('**/api/backups');await page.locator('#refreshBackups').click();await ready();
  // Confirmed failure keeps its inline preview, options and focus.
  await row.locator('[data-restore-backup]').click();let releaseRestore;const restoreGate=new Promise(resolve=>{releaseRestore=resolve;});let restoreCalls=0;
  await page.route('**/api/backups/restore',async route=>{restoreCalls++;await restoreGate;await route.fulfill({status:400,contentType:'application/json',body:'{"error":"测试恢复拒绝"}'});});
  await row.locator('[data-confirm-restore-backup]').click();await page.locator('#backupRestoreStatus').waitFor();await locked('#backupRestoreStatus');
  await page.evaluate(()=>document.querySelector('[data-confirm-restore-backup]').click());
  await capture('snapshot-restore-busy');releaseRestore();
  await page.waitForFunction(()=>document.querySelector('#backupRestoreStatus')?.textContent.includes('测试恢复拒绝')&&!document.querySelector('[data-confirm-restore-backup]').disabled);
  assert.equal(restoreCalls,1);assert.equal(await row.locator('[data-cancel-restore-backup]').isDisabled(),false);
  assert.equal(await row.locator('[data-confirm-restore-backup]').evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.locator('#toasts .toast').count(),0,'恢复失败留在快照旁，不重复全局提示');
  await capture('snapshot-restore-error-mobile',true);
  // An uncertain result freezes the accepted intent. Only its retry is usable.
  await page.unroute('**/api/backups/restore');const restoreBodies=[];
  await page.route('**/api/backups/restore',route=>{restoreBodies.push(route.request().postData());return route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试恢复待完成","migrationPending":true}'});});
  await page.route('**/api/migrations/status?**',route=>route.fulfill({contentType:'application/json',body:'{"state":"pending"}'}));
  await row.locator('[data-confirm-restore-backup]').click();await page.waitForFunction(()=>document.querySelector('[data-confirm-restore-backup]')?.textContent==='继续完成恢复');
  assert.equal(await page.locator('#dataDialog button:not(:disabled):not(.toast-dismiss)').count(),1);assert.equal(await page.locator('#dataDialog input:not(:disabled),#dataDialog select:not(:disabled)').count(),0);
  await page.keyboard.press('Escape');await page.keyboard.press('Tab');assert.equal(await row.locator('[data-confirm-restore-backup]').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await row.locator('[data-confirm-restore-backup]').evaluate(node=>node===document.activeElement),true);
  await capture('snapshot-restore-unconfirmed-mobile',true);
  await page.unroute('**/api/migrations/status?**');await page.unroute('**/api/backups/restore');
  await page.route('**/api/backups/restore',async route=>{restoreBodies.push(route.request().postData());await json('/api/backups/restore',{method:'POST',body:route.request().postData()});await route.abort('failed');});
  await row.locator('[data-confirm-restore-backup]').click();await ready();
  assert.equal(restoreBodies.length,2);assert.equal(new Set(restoreBodies).size,1);
  assert.equal((await json('/api/backups')).backups.filter(item=>item.kind==='recovery').length,1,'恢复响应丢失由回执确认，不重复保护档案或再次恢复');
  await page.unroute('**/api/backups/restore');
  // A different window can edit after preview; stale confirmation must not win.
  await row.locator('[data-restore-backup]').click();
  const latest=await json('/api/library');await json('/api/library',{method:'PUT',body:JSON.stringify({...latest,entries:latest.entries.map(item=>({...item,note:'external window'}))})});
  const externalBytes=await readFile(join(dataDir,'library.json'));
  await row.locator('[data-confirm-restore-backup]').click();
  await page.waitForFunction(()=>document.querySelector('#backupRestoreStatus')?.textContent.includes('刷新列表后重新核对'));
  assert.equal(await row.locator('[data-confirm-restore-backup]').isDisabled(),true);assert.equal(await row.locator('[data-cancel-restore-backup]').isDisabled(),false);
  assert.deepEqual(await readFile(join(dataDir,'library.json')),externalBytes);
  await capture('snapshot-restore-stale');
  await page.locator('#refreshBackups').click();await ready();await row.locator('[data-restore-backup]').click();await row.locator('[data-confirm-restore-backup]').click();await ready();
  assert.equal((await json('/api/library')).entries[0].note,'snapshot');
  // Delete response loss is recoverable without clearing the row confirmation.
  const previousIds=new Set((await json('/api/backups')).backups.map(item=>item.id));
  await page.locator('#createSnapshot').click();await ready();catalog=await json('/api/backups');
  const extra=catalog.backups.find(item=>item.kind==='manual'&&!previousIds.has(item.id));assert.ok(extra);
  const extraRow=page.locator(`[data-backup-row="${extra.id}"]`);await extraRow.locator('[data-delete-backup]').click();
  let releaseDelete;const deleteGate=new Promise(resolve=>{releaseDelete=resolve;});let deleteCalls=0;
  await page.route('**/api/backups/delete',async route=>{deleteCalls++;await deleteGate;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试删除失败"}'});});
  await extraRow.locator('[data-confirm-delete-backup]').click();await page.waitForFunction(()=>document.querySelector('#backupState').textContent==='删除中…');await locked('#backupState');releaseDelete();
  await extraRow.locator('.backup-action-error').waitFor();assert.equal(deleteCalls,1);assert.equal(await extraRow.locator('[data-confirm-delete-backup]').isDisabled(),false);
  await extraRow.scrollIntoViewIfNeeded();await capture('snapshot-delete-error-mobile',true);
  await page.unroute('**/api/backups/delete');const deleteBodies=[];
  await page.route('**/api/backups/delete',async route=>{deleteBodies.push(route.request().postData());await json('/api/backups/delete',{method:'POST',body:route.request().postData()});await route.abort('failed');});
  await extraRow.locator('[data-confirm-delete-backup]').click();await page.waitForFunction(()=>document.querySelector('[data-confirm-delete-backup]')?.textContent==='重试删除'&&!document.querySelector('[data-confirm-delete-backup]').disabled);
  await page.unroute('**/api/backups/delete');await page.route('**/api/backups/delete',route=>{deleteBodies.push(route.request().postData());return route.continue();});
  await extraRow.locator('[data-confirm-delete-backup]').click();await ready();assert.equal(await extraRow.count(),0);assert.equal(new Set(deleteBodies).size,1);
  assert.ok((await readdir(dataDir)).includes(manual.id));
  // At the actual 20-copy limit an unconfirmed twentieth creation must still
  // be confirmable; the limit must not strand the same-operation retry.
  for(let i=0;i<18;i++)await json('/api/backups/create',{method:'POST',body:'{}'});
  await page.locator('#refreshBackups').click();await ready();
  assert.equal((await json('/api/backups')).backups.filter(item=>item.kind==='manual').length,19);
  await page.route('**/api/backups/create',async route=>{await json('/api/backups/create',{method:'POST',body:route.request().postData()});await route.abort('failed');});
  await page.locator('#createSnapshot').click();await page.waitForFunction(()=>document.querySelector('#backupState').textContent.includes('创建未确认')&&!document.querySelector('#createSnapshot').disabled);
  await page.unroute('**/api/backups/create');await page.locator('#refreshBackups').click();await ready();
  assert.equal(await page.locator('#createSnapshot').isDisabled(),false,'达到上限仍可确认已接受的同一次创建');
  await page.locator('#createSnapshot').click();await ready();
  assert.equal(await page.locator('#createSnapshot').isDisabled(),true);
  assert.equal((await json('/api/backups')).backups.filter(item=>item.kind==='manual').length,20);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,manualSnapshots:20,protectedArchives:2,scenarios:['create rejection/response loss/quota boundary','catalogue failure','restore rejection/pending/response loss','stale window','delete rejection/response loss']}));
}finally{
  await browser?.close();await new Promise(resolve=>server.close(resolve));
}
