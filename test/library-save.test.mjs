import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {LibraryStore,LIBRARY_FORMAT_VERSION,MAX_SAVE_RECEIPTS,librarySaveRequest} from '../lib/store.mjs';
import {entry,preferences} from '../src/model.js';
import {librarySavePayload,librarySaveFingerprint,resolveLibrarySave} from '../src/library-save.js';
import {MigrationCoordinator} from '../lib/migration.mjs';
import {CoverCache} from '../lib/cover-cache.mjs';
import {createBackup} from '../src/backup.js';

const work=()=>entry({id:'manual:save',title:'星海巡航',type:'anime',updatedAt:'2026-10-10T00:00:00.000Z'});
const request=(revision=0,entries=[work()],settings=preferences())=>({requestId:randomUUID(),revision,entries,settings});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'fandu-save-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,store:new LibraryStore(dir)};}
test('save receipts survive restart, later settings/notes and deletion without replaying old data',async t=>{
  const {dir,store}=await fixture(t),payload=request();const results=await Promise.all([store.saveWithReceipt(payload),store.saveWithReceipt(payload)]);
  assert.equal(results[0].revision,1);assert.equal(results[0].replayed,false);assert.equal(results[1].replayed,true);assert.equal(results[1].library.revision,1);assert.equal(results[0].fingerprint,await librarySaveFingerprint(payload));
  const restarted=new LibraryStore(dir);let library=await restarted.read();assert.equal(Object.hasOwn(library,'saveReceipts'),false);
  await restarted.save({...library,saveReceipts:[],entries:library.entries.map(item=>({...item,note:'后来的笔记',rating:5})),settings:{...library.settings,theme:'amber'}});
  let replay=await restarted.saveWithReceipt(payload);assert.equal(replay.library.revision,2);assert.equal(replay.library.entries[0].note,'后来的笔记');assert.equal(replay.library.entries[0].rating,5);assert.equal(replay.library.settings.theme,'amber');
  library=await restarted.read();await restarted.save({...library,entries:[]});replay=await restarted.saveWithReceipt(payload);assert.deepEqual(replay.library.entries,[]);assert.equal(replay.library.revision,3);assert.equal((await restarted.saveStatus(payload.requestId)).revision,1);
  assert.equal(JSON.parse(await readFile(join(dir,'library.json'),'utf8')).saveReceipts.length,1);
  for(const changed of [{entries:[]},{settings:{...payload.settings,theme:'violet'}},{revision:1}])await assert.rejects(restarted.saveWithReceipt({...payload,...changed}),{status:409});
});
test('different concurrent edits reject stale versions; confirmation cannot overwrite the winner',async t=>{
  const {store}=await fixture(t),a=request(),b=request();b.entries[0].note='另一窗口';
  const outcomes=await Promise.allSettled([store.saveWithReceipt(a),store.saveWithReceipt(b)]);assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].reason.status,409);assert.equal((await store.saveStatus(b.requestId)).state,'unknown');assert.equal((await store.read()).revision,1);
});
test('bounded receipts expire without allowing a stale save or undo to run again',async t=>{
  const {dir,store}=await fixture(t),first=request();await store.saveWithReceipt(first);
  for(let revision=1;revision<=MAX_SAVE_RECEIPTS;revision++)await store.saveWithReceipt(request(revision,[],preferences({theme:revision%2?'cyan':'blue'})));
  assert.equal((await store.saveStatus(first.requestId)).state,'unknown');await assert.rejects(store.saveWithReceipt(first),{status:409});assert.deepEqual((await store.read()).entries,[]);
  const disk=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));assert.equal(disk.saveReceipts.length,MAX_SAVE_RECEIPTS);assert.ok(Buffer.byteLength(JSON.stringify(disk.saveReceipts))<12000);
});
test('legacy v0/v1 archives upgrade only on write, preserving original bytes during reads',async t=>{
  const {dir,store}=await fixture(t),path=join(dir,'library.json');
  for(const version of [undefined,1]){
    const legacy={...(version?{formatVersion:version}:{}),revision:7,entries:[work()],settings:{theme:'violet'}},raw=JSON.stringify(legacy);await writeFile(path,raw);
    const library=await store.read();assert.equal(library.formatVersion,LIBRARY_FORMAT_VERSION);assert.equal(await readFile(path,'utf8'),raw);
    await store.saveWithReceipt(request(7,library.entries,library.settings));assert.equal(JSON.parse(await readFile(path,'utf8')).formatVersion,2);
  }
});
test('browser and server fingerprints normalize field order, dates and preferences identically',async t=>{
  const {store}=await fixture(t),payload=request(),raw={settings:{theme:'blue'},entries:payload.entries.map(item=>({...Object.fromEntries(Object.entries(item).reverse()),updatedAt:'2026-10-10T08:00:00+08:00',ignored:'not a field'})),revision:0,requestId:payload.requestId};
  assert.equal(await librarySaveFingerprint(raw),librarySaveRequest(raw).fingerprint);assert.equal(await librarySaveFingerprint(raw),await librarySaveFingerprint(payload));
  const first=await store.saveWithReceipt(raw),retry=await store.saveWithReceipt(payload);assert.equal(first.fingerprint,retry.fingerprint);assert.equal(retry.replayed,true);assert.equal(retry.library.revision,1);
});
test('save and addition IDs cannot be reused across operation types, and both histories coexist',async t=>{
  const {dir,store}=await fixture(t),payload=request();await store.saveWithReceipt(payload);
  const added={requestId:randomUUID(),revision:1,entry:entry({id:'manual:added',title:'边界之外',type:'movie',createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z'})};
  await assert.rejects(store.addEntry({...added,requestId:payload.requestId}),{status:409});await store.addEntry(added);
  const current=await store.read();await assert.rejects(store.saveWithReceipt({...request(current.revision,current.entries,current.settings),requestId:added.requestId}),{status:409});
  const disk=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));assert.equal(disk.saveReceipts.length,1);assert.equal(disk.addReceipts.length,1);assert.equal((await store.saveStatus(payload.requestId)).library.entries.length,2);assert.equal((await store.additionStatus(added.requestId)).state,'completed');
});
test('invalid identities, dates, complete settings and revisions fail without changing bytes',async t=>{
  const {dir,store}=await fixture(t),payload=request();await store.saveWithReceipt(payload);const path=join(dir,'library.json'),before=await readFile(path);
  for(const changed of [{requestId:[randomUUID()]},{requestId:'bad'},{revision:-1},{revision:NaN},{settings:null},{settings:[]},{entries:Array(1)},{entries:[{...work(),updatedAt:null}]},{entries:[{...work(),createdAt:2026}]}])await assert.rejects(store.saveWithReceipt({...payload,...changed}),{status:400});
  assert.deepEqual(await readFile(path),before);assert.equal(librarySavePayload(request()).entries[0].createdAt,null);
  await assert.rejects(store.saveStatus([payload.requestId]),{status:400});
});
test('malformed or future receipt metadata remains read-only',async t=>{
  const {dir,store}=await fixture(t),payload=request();await store.saveWithReceipt(payload);const path=join(dir,'library.json'),good=JSON.parse(await readFile(path,'utf8')),receipt=good.saveReceipts[0];
  const variants=[null,{},[null],[{...receipt,requestId:[receipt.requestId]}],[{...receipt,fingerprint:[receipt.fingerprint]}],[{...receipt,revision:2}],[receipt,receipt],Array(MAX_SAVE_RECEIPTS+1).fill(receipt)];
  for(const saveReceipts of variants){const raw=JSON.stringify({...good,saveReceipts});await writeFile(path,raw);await assert.rejects(store.read(),/无法读取/);await assert.rejects(store.saveWithReceipt(payload),/无法读取/);assert.equal(await readFile(path,'utf8'),raw);}
  const raw=JSON.stringify({...good,formatVersion:LIBRARY_FORMAT_VERSION+1});await writeFile(path,raw);await assert.rejects(store.saveWithReceipt(payload),/升级番渡/);assert.equal(await readFile(path,'utf8'),raw);
});
test('client completion proves exact request content and permits later edits in the returned archive',async()=>{
  const payload=librarySavePayload(request()),fingerprint=await librarySaveFingerprint(payload),result={state:'completed',requestId:payload.requestId,fingerprint,revision:1,library:{revision:2,entries:[],settings:preferences({theme:'amber'})}};
  const lost=async received=>{assert.equal(received,payload);throw Error('响应丢失');};assert.equal((await resolveLibrarySave(payload,{send:lost,confirm:async()=>result})).state,'completed');
  const conflict=async()=>{throw Object.assign(Error('版本冲突'),{status:409});};assert.equal((await resolveLibrarySave(payload,{send:conflict,confirm:async()=>result})).state,'completed');
  const unknown=async()=>({state:'unknown',requestId:payload.requestId});assert.equal((await resolveLibrarySave(payload,{send:lost,confirm:unknown})).state,'pending');assert.equal((await resolveLibrarySave(payload,{send:conflict,confirm:unknown})).state,'rejected');
  for(const altered of [{requestId:randomUUID()},{fingerprint:'0'.repeat(64)},{revision:2},{library:{revision:0,entries:[],settings:preferences()}},{library:{revision:1,entries:[{}],settings:preferences()}},{library:{revision:1,entries:[],settings:null}}])assert.equal((await resolveLibrarySave(payload,{send:async()=>({...result,...altered}),confirm:async()=>({...result,...altered})})).state,'pending');
  assert.equal((await resolveLibrarySave(payload,{send:async()=>{throw Object.assign(Error('迁移待完成'),{status:409,migrationPending:true});},confirm:unknown})).state,'pending');
  assert.equal((await resolveLibrarySave(payload,{send:conflict,confirm:async()=>({state:'unknown',requestId:randomUUID()})})).state,'pending');
});
test('v2 operation histories reject coerced addition identities and overlapping completion versions',async t=>{
  const {dir,store}=await fixture(t),payload=request();await store.saveWithReceipt(payload);const path=join(dir,'library.json'),good=JSON.parse(await readFile(path,'utf8')),receipt={requestId:randomUUID(),fingerprint:'a'.repeat(64),entryId:'manual:added',revision:2};
  await assert.rejects(store.addEntry({requestId:[randomUUID()],revision:1,entry:{...work(),createdAt:'2026-10-10T00:00:00Z'}}),{status:400});
  await assert.rejects(store.additionStatus([randomUUID()]),{status:400});
  for(const addReceipts of [[{...receipt,requestId:[receipt.requestId]}],[{...receipt,fingerprint:[receipt.fingerprint]}],[receipt,{...receipt,requestId:randomUUID()}],[{...receipt,revision:1}],[{...receipt,requestId:payload.requestId}]]){
    const raw=JSON.stringify({...good,revision:2,addReceipts});await writeFile(path,raw);await assert.rejects(store.read(),/无法读取/);await assert.rejects(store.saveWithReceipt(payload),/无法读取/);assert.equal(await readFile(path,'utf8'),raw);
  }
});
for(const fault of ['write','sync','rename','directory-sync','crash-before','crash-after'])test(`save receipt ${fault}: contents and completion proof stay atomic`,async t=>{
  const {dir,store}=await fixture(t),initial=await store.save({revision:0,entries:[work()]}),payload=request(initial.revision,initial.entries.map(item=>({...item,note:'新笔记'})),{...initial.settings,theme:'cyan'});await writeFile(join(dir,'save-request.json'),JSON.stringify(payload));
  const outcome=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/storage-fault-worker.mjs',import.meta.url)),dir,'save-receipt',fault],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fault worker timeout'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr});});});
  assert.equal(outcome.stderr,'');if(fault.startsWith('crash'))assert.equal(outcome.signal,'SIGKILL');else assert.equal(outcome.code,71);
  const published=['directory-sync','crash-after'].includes(fault),restarted=new LibraryStore(dir),read=await restarted.read();assert.equal(read.revision,published?2:1);assert.equal(read.entries[0].note,published?'新笔记':'');assert.equal((await restarted.saveStatus(payload.requestId)).state,published?'completed':'unknown');
  const retry=await restarted.saveWithReceipt(payload);assert.equal(retry.replayed,published);assert.equal(retry.library.revision,2);assert.equal(retry.library.entries[0].note,'新笔记');assert.equal(retry.library.settings.theme,'cyan');assert.equal(JSON.parse(await readFile(join(dir,'library.json'),'utf8')).saveReceipts.length,1);
});
for(const operation of ['save-receipt-confirm','save-receipt-replay'])test(`${operation}: directory-sync failure cannot claim completed`,async t=>{
  const {dir,store}=await fixture(t),payload=request();await store.saveWithReceipt(payload);await writeFile(join(dir,'save-request.json'),JSON.stringify(payload));const before=await readFile(join(dir,'library.json'));
  const outcome=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/storage-fault-worker.mjs',import.meta.url)),dir,operation,'directory-sync'],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fault worker timeout'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr});});});
  assert.equal(outcome.code,71,outcome.stderr);assert.equal(outcome.stderr,'');assert.deepEqual(await readFile(join(dir,'library.json')),before);assert.equal((await store.saveStatus(payload.requestId)).state,'completed');assert.equal((await store.saveWithReceipt(payload)).library.revision,1);
});
test('HTTP save proof uses same-origin protection, rejects stale writes and confirms exact duplicates',async t=>{
  const {dir}=await fixture(t),server=makeServer({dataDir:dir});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'},payload=request();
  for(const unsafe of [{'Content-Type':'application/json'},{...headers,Origin:'https://example.com'},{...headers,'Sec-Fetch-Site':'cross-site'}])assert.equal((await fetch(base+'/api/library/save',{method:'POST',headers:unsafe,body:JSON.stringify(payload)})).status,403);
  const results=await Promise.all(Array.from({length:3},async()=>{const response=await fetch(base+'/api/library/save',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,200);return response.json();}));assert.equal(results.filter(item=>!item.replayed).length,1);
  const stale=await fetch(base+'/api/library/save',{method:'POST',headers,body:JSON.stringify(request())});assert.equal(stale.status,409);
  const current=await(await fetch(base+'/api/library',{headers})).json();await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...current,entries:[]})});
  const response=await fetch(base+'/api/library/save-status?id='+payload.requestId,{headers});assert.equal(response.status,200);const status=await response.json();assert.equal(status.revision,1);assert.equal(status.library.revision,2);assert.deepEqual(status.library.entries,[]);assert.equal(Object.hasOwn(status.library,'saveReceipts'),false);assert.equal(Object.hasOwn(status.library,'addReceipts'),false);
  assert.equal((await fetch(base+'/api/library/save-status?id=invalid',{headers})).status,400);assert.equal((await fetch(base+'/api/library/save-status?id='+payload.requestId)).status,403);
  assert.equal((await fetch(base+'/src/library-save.js',{headers})).status,200);assert.equal((await fetch(base+'/lib/store.mjs',{headers})).status,404);
});
test('import recovery retains save receipts; snapshot restore clears them and stale payloads cannot replay',async t=>{
  const {dir,store}=await fixture(t),payload=request();await store.saveWithReceipt(payload);const covers=new CoverCache(join(dir,'covers'));await covers.ready;
  let fail=true;const coordinator=new MigrationCoordinator({dir,store,covers,onStage:async stage=>{if(stage==='archive'&&fail)throw Error('中断导入');}}),initial=await store.read(),imported={requestId:randomUUID(),revision:initial.revision,entries:initial.entries.map(item=>({...item,note:'导入后修改'})),settings:initial.settings};
  await assert.rejects(coordinator.import(imported),{status:503});fail=false;const recovered=await coordinator.import(imported);assert.equal(recovered.library.revision,2);assert.equal((await store.saveStatus(payload.requestId)).library.entries[0].note,'导入后修改');
  const library=await store.read(),exported=await createBackup(library.entries,library.settings);assert.equal(Object.hasOwn(exported,'saveReceipts'),false);assert.equal(exported.entries[0].note,'导入后修改');
  const catalog=await store.createSnapshot(),selected=catalog.backups.find(item=>item.kind==='manual');await coordinator.restore({requestId:randomUUID(),id:selected.id,token:selected.token,currentToken:catalog.current.token});assert.equal((await store.saveStatus(payload.requestId)).state,'unknown');await assert.rejects(store.saveWithReceipt(payload),{status:409});assert.equal((await store.read()).entries[0].note,'导入后修改');
});
