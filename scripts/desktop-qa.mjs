import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
const packaged=process.argv.includes('--packaged');
const explicitExecutable=process.env.FANDU_QA_EXECUTABLE;
if(explicitExecutable&&!isAbsolute(explicitExecutable))throw Error('FANDU_QA_EXECUTABLE 必须是绝对路径');
const electronPath=explicitExecutable||(packaged?resolve('dist/mac-arm64/番渡.app/Contents/MacOS/番渡'):createRequire(import.meta.url)('electron'));
const {_electron}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-desktop-qa-')),profile=join(output,'profile'),errors=[];
let desktop;
async function launch(){
  desktop=await _electron.launch({chromiumSandbox:true,executablePath:electronPath,args:packaged||explicitExecutable?[]:[resolve('desktop/main.mjs')],env:{...process.env,FANDU_DESKTOP_PROFILE:profile,FANDU_DESKTOP_QA:'1'},timeout:25000});
  desktop.process().stderr.on('data',data=>process.stderr.write(data));
  const page=await desktop.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>!document.querySelector('#addWork').disabled);
  return page;
}
async function close(){const process=desktop.process(),closed=desktop.waitForEvent('close',{timeout:15000});await desktop.evaluate(({app})=>{setTimeout(()=>app.quit(),20);});await closed;assert.equal(process.exitCode,0);desktop=null;}
try{
  let page=await launch();assert.equal(page.url(),'fandu://app/');
  assert.deepEqual(await page.evaluate(()=>({node:typeof process,require:typeof require,secure:isSecureContext})),{node:'undefined',require:'undefined',secure:true});
  const prefs=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);
  await page.evaluate(()=>{window.localStorage.setItem('desktop-persistence-check','kept');});
  await page.locator('#emptyManual').click();await page.locator('#entryForm [name=title]').fill('桌面跨重启自动保存');await page.locator('#entryForm [name=total]').fill('12');await page.waitForFunction(()=>document.querySelector('#entrySaveState').textContent==='草稿已保存');
  await page.screenshot({path:join(output,'desktop-entry.png')});
  await close();page=await launch();assert.equal(await page.evaluate(()=>localStorage.getItem('desktop-persistence-check')),'kept');
  await page.locator('#entryRecoverySummary').click();await page.locator('[data-resume-entry]').filter({hasText:'桌面跨重启自动保存'}).click();await page.waitForFunction(()=>document.querySelector('#entryForm [name=title]').value==='桌面跨重启自动保存');await page.locator('#createEntry').click();await page.locator('#noteInput').waitFor();await page.locator('#noteInput').fill('桌面版本重启后保留的笔记');await page.waitForFunction(()=>document.querySelector('#noteSaveState')?.textContent==='已保存');
  await page.screenshot({path:join(output,'desktop-detail.png')});
  await close();page=await launch();const library=await page.evaluate(async()=>await(await fetch('/api/library',{headers:{'X-Yingjian':'1'}})).json());assert.equal(library.entries.length,1);assert.equal(library.entries[0].note,'桌面版本重启后保留的笔记');
  assert.equal((await readFile(join(profile,'data','library.json'),'utf8')).includes('桌面跨重启自动保存'),true);
  // Verify the native download path using an isolated explicit target instead
  // of interacting with the user's file picker or Downloads directory.
  await desktop.evaluate(({session},target)=>{globalThis.fanduDownloadState='waiting';session.fromPartition('persist:fandu-v1').once('will-download',(_event,item)=>{item.setSavePath(target);item.once('done',(_event,state)=>globalThis.fanduDownloadState=state);});},join(output,'desktop-export.json'));
  await page.evaluate(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({desktop:true})],{type:'application/json'}));a.download='desktop-export.json';a.click();});
  const deadline=Date.now()+12000;let downloadState;do{downloadState=await desktop.evaluate(()=>globalThis.fanduDownloadState);if(downloadState!=='waiting')break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);assert.equal(downloadState,'completed');assert.deepEqual(JSON.parse(await readFile(join(output,'desktop-export.json'),'utf8')),{desktop:true});
  assert.deepEqual(errors,[]);await close();console.log(JSON.stringify({passed:true,output,scenarios:['sandboxed custom origin and persistent browser storage','entry draft and saved note survive three native launches','native export writes only the isolated requested destination']}));
}finally{if(desktop)await desktop.close();}
