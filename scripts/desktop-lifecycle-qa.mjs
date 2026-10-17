import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const {_electron}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-desktop-lifecycle-')),profile=join(output,'profile');
const desktop=await _electron.launch({chromiumSandbox:true,executablePath:createRequire(import.meta.url)('electron'),args:[resolve('desktop/main.mjs')],env:{...process.env,FANDU_DESKTOP_PROFILE:profile,FANDU_DESKTOP_QA:'1'},timeout:20000});
const childProcess=desktop.process();let closed=false;
async function until(check){const end=Date.now()+10000;do{if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<end);throw Error('桌面状态未在期限内完成');}
try{
  let page=await desktop.firstWindow();page.setDefaultTimeout(10000);page.on('dialog',()=>{});await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);
  const oldId=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].id);
  await desktop.evaluate(({BrowserWindow,app})=>{BrowserWindow.getAllWindows()[0].close();setTimeout(()=>{app.emit('activate');app.emit('activate');app.emit('second-instance');},30);});
  await until(()=>desktop.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().some(w=>w.id!==id&&w.webContents.getURL()==='fandu://app/'&&!w.webContents.isLoading()),oldId));
  assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  page=desktop.windows().find(candidate=>!candidate.isClosed());page.on('dialog',()=>{});await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);
  // Keep a real draft write waiting, then cancel a native quit. The service
  // must remain usable and the original input must still be able to save.
  await page.evaluate(()=>{const original=window.fetch;window.draftWriteHeld=false;window.fetch=async(...args)=>{if(String(args[0]).startsWith('/api/entry-drafts')&&args[1]?.method==='PUT'){window.draftWriteHeld=true;await new Promise(resolve=>window.releaseHeldDraft=resolve);}return original(...args);};});
  await page.locator('#emptyManual').click();await page.locator('#entryForm [name=title]').fill('退出取消后仍能保存');await page.waitForFunction(()=>window.draftWriteHeld);
  await desktop.evaluate(({dialog,app})=>{globalThis.quitDialogs=0;dialog.showMessageBoxSync=(_window,options)=>{globalThis.quitDialogs++;globalThis.quitOptions=options;return 0;};setTimeout(()=>app.quit(),10);});
  await until(()=>desktop.evaluate(()=>globalThis.quitDialogs>0));
  assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  assert.equal(await desktop.evaluate(()=>globalThis.quitOptions.defaultId),0);
  assert.equal(await page.locator('#entryForm [name=title]').inputValue(),'退出取消后仍能保存');
  await page.evaluate(()=>window.releaseHeldDraft());await page.waitForFunction(()=>document.querySelector('#entrySaveState').textContent==='草稿已保存');
  assert.equal(JSON.parse(await readFile(join(profile,'data','entry-drafts.json'),'utf8')).items[0].draft.values.title,'退出取消后仍能保存');
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1010,740));
  const complete=desktop.waitForEvent('close');await desktop.evaluate(({app})=>{setTimeout(()=>app.quit(),10);});await complete;closed=true;assert.equal(childProcess.exitCode,0);
  const bounds=JSON.parse(await readFile(join(profile,'window-state.json'),'utf8'));assert.equal(bounds.width,1010);assert.equal(bounds.height,740);
  console.log(JSON.stringify({passed:true,output,scenarios:['simultaneous Dock activation and second launch create only one window','native quit defaults to continue editing and leaves the draft service running','clean quit drains writes and saves normal window bounds']}));
}finally{if(!closed)await desktop.close();}
