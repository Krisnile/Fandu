import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {Sources} from '../lib/sources.mjs';
import {auditTextContrast} from './text-contrast.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-entry-ui-')),sources=new Sources();
sources.search=async()=>({state:'ok',results:[]});sources.season=async()=>({state:'ok',results:[],source:'yuc'});
const server=makeServer({dataDir:join(output,'data'),sources});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
const initial=await(await fetch(base+'/api/library',{headers})).json();
const initialized=await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...initial,settings:{...initial.settings,series:[{id:'space',label:'星海系列'}]}})});assert.equal(initialized.status,200);
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);await page.emulateMedia({reducedMotion:'reduce'});
  const errors=[],reports=[];let dialogs=0;page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});
  await page.route('**/api/source-icon?**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'}));
  await page.goto(base);await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);
  const title=page.locator('#entryForm [name=title]'),create=page.locator('#createEntry');
  const open=async()=>{await page.locator(await page.locator('#addWork').isVisible()?'#addWork':'#emptyManual').click();await title.waitFor();};
  const capture=async name=>{const report=await page.evaluate(auditTextContrast,'#entryDialog');reports.push({name,...report});assert.equal(report.failures.length,0,name+' text contrast');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(output,name+'.png')});};
  await open();await page.locator('#cancelEntry').click();await page.locator('#entryDialog').waitFor({state:'hidden'});
  await open();await title.fill('临时草稿');await title.fill('');await page.locator('#cancelEntry').click();await page.locator('#entryDialog').waitFor({state:'hidden'});
  await open();await title.fill('星海巡航');await title.dispatchEvent('compositionstart');await title.dispatchEvent('keydown',{key:'Escape',isComposing:true});assert.equal(await page.locator('#entryDiscard').isHidden(),true);await title.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');await page.locator('#entryDiscard').waitFor();assert.equal(await page.locator('#keepEntry').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('#discardEntry').evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  assert.equal(await title.inputValue(),'星海巡航');assert.equal(await page.locator('#entryDiscard').isHidden(),true);
  await page.locator('#entrySeriesQuery').focus();await page.locator('#entrySeriesSuggestions').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#entryDiscard').isHidden(),true);assert.equal(await page.locator('#entrySeriesSuggestions').isHidden(),true);await page.keyboard.press('Escape');await page.locator('#keepEntry').click();
  await page.locator('#entryForm [name=total]').fill('12');await page.locator('#entryForm [name=progress]').fill('13');await create.click();assert.match(await page.locator('#entryAddState').textContent(),/不能大于/);assert.equal(await page.locator('#entryForm [name=progress]').getAttribute('aria-invalid'),'true');await page.waitForFunction(()=>getComputedStyle(document.querySelector('#entryForm [name=progress]')).borderTopColor===getComputedStyle(document.querySelector('#entryAddState')).color);await capture('cross-field-error');
  await page.locator('#entryForm [name=progress]').fill('3');assert.equal(await page.locator('#entryForm [name=progress]').getAttribute('aria-invalid'),null);
  let payloads=[],release,started;
  const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve);
  await page.route('**/api/entries/add',async route=>{payloads.push(route.request().postDataJSON());started();await gate;await route.abort('failed');});
  await page.route('**/api/entries/add-status?**',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试确认不可用"}'}));
  await create.click();await began;assert.equal(await title.isDisabled(),true);assert.equal(await page.locator('#cancelEntry').isDisabled(),true);await page.keyboard.press('Tab');assert.equal(await page.locator('#entryAddState').evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#entryDialog').isVisible(),true);await capture('adding-locked');
  release();await page.waitForFunction(()=>document.querySelector('#createEntry').textContent==='继续添加');assert.equal(await title.isDisabled(),true);assert.equal(await create.isDisabled(),false);await capture('unconfirmed-locked');
  await page.unroute('**/api/entries/add');await page.unroute('**/api/entries/add-status?**');
  await page.route('**/api/entries/add',async route=>{payloads.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');});
  await create.click();await page.locator('#entryDialog').waitFor({state:'hidden'});await page.locator('#noteInput').waitFor();assert.deepEqual(payloads[0],payloads[1]);
  let library=await(await fetch(base+'/api/library',{headers})).json();assert.equal(library.entries.length,1);assert.equal(library.entries[0].progress,3);assert.equal(library.entries[0].title,'星海巡航');await page.unroute('**/api/entries/add');await page.locator('#closeDrawer').click();
  await open();await title.fill('拒绝后保留');await page.route('**/api/entries/add',route=>route.fulfill({status:409,contentType:'application/json',body:'{"error":"测试版本冲突"}'}));await create.click();await page.waitForFunction(()=>document.querySelector('#entryAddState').textContent.includes('测试版本冲突'));assert.equal(await title.isDisabled(),false);assert.equal(await title.inputValue(),'拒绝后保留');await capture('known-rejection');await page.unroute('**/api/entries/add');
  await page.locator('#cancelEntry').click();await page.locator('#discardEntry').click();
  // Test status, discard and validation with actual persisted theme choices.
  for(const width of [1280,390])for(const mode of ['dark','light'])for(const theme of ['blue','violet','cyan','graphite','amber']){
    library=await(await fetch(base+'/api/library',{headers})).json();
    const response=await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...library,settings:{...library.settings,theme,mode,accent:''}})});assert.equal(response.status,200);
    await page.setViewportSize({width,height:850});await page.reload();await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);assert.equal(await page.locator('html').getAttribute('data-theme'),theme);assert.equal(await page.locator('html').getAttribute('data-mode'),mode);await open();
    await create.click();assert.match(await page.locator('#entryAddState').textContent(),/作品名称/);await capture(`${width}-${mode}-${theme}-invalid`);
    await title.fill('配色与取消检查');await page.locator('#cancelEntry').click();await page.locator('#entryDiscard').waitFor();await capture(`${width}-${mode}-${theme}-discard`);await page.locator('#discardEntry').click();
  }
  assert.deepEqual(errors,[]);assert.equal(dialogs,0);await writeFile(join(output,'contrast-report.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify({passed:true,output,screens:reports.length,scenarios:['clean and reverted drafts close directly','IME Escape preserved','inline discard traps focus and safe Enter','series Escape dismisses picker first','cross-field validation','submission locks and traps focus','unknown result freezes exact payload','lost committed response confirms exactly once','known rejection preserves editable draft','all presets desktop/mobile validation and discard']}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
