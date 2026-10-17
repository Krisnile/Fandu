import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LibraryStore} from '../lib/store.mjs';
import {EntryDraftStore,MAX_ENTRY_DRAFTS,MAX_DISCARDED_DRAFT_IDS} from '../lib/drafts.mjs';
import {entry} from '../src/model.js';
import {makeServer} from '../server.mjs';
const draft=()=>({kind:'form',values:{title:'星海巡航',type:'anime',status:'planned',progress:'13',total:'12',note:'未提交的草稿'},lists:[],seed:null,enrichQuery:'星海',baseline:'initial'});
const intent=()=>({requestId:randomUUID(),revision:0,entry:entry({id:randomUUID(),type:'anime',title:'星海巡航',createdAt:new Date().toISOString()})});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'fandu-drafts-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new LibraryStore(dir);await store.read();return {dir,store,drafts:new EntryDraftStore(dir,store)};}
const putState=async(dir,payload)=>writeFile(join(dir,'entry-drafts.json'),JSON.stringify({...payload,checksum:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}));
test('invalid form values survive restart; retries are idempotent and stale windows cannot overwrite',async t=>{
  const {dir,store,drafts}=await fixture(t),{id}=await drafts.allocate(),request={id,version:0,draft:draft()};
  const first=await drafts.save(request);assert.equal(first.version,1);assert.equal((await drafts.save(request)).version,1);
  const restarted=new EntryDraftStore(dir,store);assert.equal((await restarted.read())[0].draft.values.progress,'13');
  await restarted.save({id,version:1,draft:{...draft(),values:{...draft().values,note:'后来修改'}}});
  await assert.rejects(drafts.save({...request,draft:{...draft(),values:{title:'过时窗口'}}}),{status:409});
  await assert.rejects(drafts.remove({id,version:1}),{status:409});assert.equal((await drafts.read())[0].draft.values.note,'后来修改');
});

test('bounded generations allow repeated churn without reviving ended or never-saved IDs; active intentions survive',async t=>{
  const {dir,store,drafts}=await fixture(t),active={...await drafts.allocate(),draft:draft()},pending={...await drafts.allocate(),draft:draft(),intent:intent()},unused=await drafts.allocate();
  await drafts.save(active);await drafts.save(pending);const firstEpoch=(await drafts.readState()).epoch,ended=[];
  for(let cycle=0;cycle<3;cycle++){
    const epoch=(await drafts.readState()).epoch;
    for(let index=0;index<MAX_DISCARDED_DRAFT_IDS;index++){
      const allocation=await drafts.allocate();ended.push(allocation.id);await drafts.remove(allocation);
    }
    const state=await drafts.readState();assert.notEqual(state.epoch,epoch);assert.equal(state.discardedIds.length,0);assert.equal(state.items.length,2);
  }
  assert.notEqual((await drafts.readState()).epoch,firstEpoch);
  for(const id of [ended[0],ended.at(-1),unused.id])await assert.rejects(drafts.save({id,version:0,draft:draft()}),{status:409});
  assert.equal((await drafts.save(pending)).intent.requestId,pending.intent.requestId);
  await drafts.save({...active,version:1,draft:{...draft(),values:{...draft().values,note:'跨代继续编辑'}}});
  await store.addEntry(pending.intent);await drafts.remove({id:pending.id,requestId:pending.intent.requestId});
  const next=await drafts.allocate();await drafts.save({...next,draft:draft()});assert.equal((await drafts.read()).length,2);
  assert.ok((await readFile(join(dir,'entry-drafts.json'))).length<12000,'结束记录不能随总使用次数持续增长');
});

test('v1 migration keeps active raw values and frozen intentions, rejects every absent legacy ID and removes lifetime ceiling',async t=>{
  const {dir,store,drafts}=await fixture(t),legacy={id:randomUUID(),version:1,draft:draft(),intent:null,updatedAt:new Date().toISOString()},pending={...legacy,id:randomUUID(),intent:intent()},ended=Array.from({length:20000},()=>randomUUID());
  await putState(dir,{formatVersion:1,items:[legacy,pending],discardedIds:ended});const before=await readFile(join(dir,'entry-drafts.json'));
  assert.deepEqual(await drafts.read(),[legacy,pending]);assert.deepEqual(await readFile(join(dir,'entry-drafts.json')),before,'读取旧格式不能擅自升级');
  const allocated=await drafts.allocate(),raw=JSON.parse(await readFile(join(dir,'entry-drafts.json'),'utf8'));assert.equal(raw.formatVersion,2);assert.equal(raw.discardedIds.length,0);assert.deepEqual(raw.items,[legacy,pending]);
  for(const id of [ended[0],ended.at(-1),randomUUID()])await assert.rejects(drafts.save({id,version:0,draft:draft()}),{status:409});
  await drafts.save({...legacy,draft:{...draft(),values:{...draft().values,note:'旧草稿继续自动保存'}}});
  await store.addEntry(pending.intent);await drafts.remove({id:pending.id,requestId:pending.intent.requestId});await drafts.save({...allocated,draft:draft()});assert.equal((await drafts.read()).length,2);
});

test('invalid namespace and future draft format remain byte-for-byte read-only',async t=>{
  const {dir,drafts}=await fixture(t);
  for(const payload of [{formatVersion:2,epoch:'invalid',items:[],discardedIds:[]},{formatVersion:2,epoch:[randomUUID()],items:[],discardedIds:[]},{formatVersion:2,epoch:randomUUID(),items:[]},{formatVersion:1,items:[],discardedIds:[[randomUUID()]]},{formatVersion:3,epoch:randomUUID(),items:[],discardedIds:[]}]){
    await putState(dir,payload);const before=await readFile(join(dir,'entry-drafts.json'));await assert.rejects(drafts.allocate(),{status:503});await assert.rejects(drafts.remove({id:randomUUID(),version:0}),{status:503});assert.deepEqual(await readFile(join(dir,'entry-drafts.json')),before);
  }
});

for(const operation of ['draft-rotate','draft-upgrade'])for(const fault of ['write','sync','rename','directory-sync','crash-before','crash-after'])test(`${operation} ${fault}: old or new namespace remains complete and retry preserves active records`,async t=>{
  const {dir,store,drafts}=await fixture(t);let record;
  if(operation==='draft-upgrade'){
    record={id:randomUUID(),version:1,draft:draft(),intent:null,updatedAt:new Date().toISOString()};await putState(dir,{formatVersion:1,items:[record],discardedIds:[randomUUID()]});
  }else{
    record=await drafts.save({...await drafts.allocate(),draft:draft()});const {epoch}=await drafts.readState();await drafts.write([record],Array.from({length:MAX_DISCARDED_DRAFT_IDS-1},()=>epoch+':'+randomUUID()),epoch);await writeFile(join(dir,'draft-request.json'),JSON.stringify({id:record.id,version:record.version}));
  }
  const result=await new Promise((resolve,reject)=>{
    const worker=spawn(process.execPath,[fileURLToPath(new URL('../scripts/storage-fault-worker.mjs',import.meta.url)),dir,operation,fault],{stdio:['ignore','pipe','pipe']});let stderr='';worker.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(Error('Draft transition worker timed out'));},10000);
    worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr});});
  });
  assert.equal(result.stderr,'');if(fault.startsWith('crash'))assert.equal(result.signal,'SIGKILL');else assert.equal(result.code,71);
  const published=['directory-sync','crash-after'].includes(fault),restarted=new EntryDraftStore(dir,store);
  if(operation==='draft-upgrade'){
    assert.deepEqual(await restarted.read(),[record]);assert.equal(Boolean((await restarted.readState()).epoch),published);await restarted.allocate();assert.deepEqual(await restarted.read(),[record]);
    await assert.rejects(restarted.save({id:randomUUID(),version:0,draft:draft()}),{status:409});
  }else{
    assert.equal((await restarted.read()).length,published?0:1);await restarted.remove({id:record.id,version:record.version});await assert.rejects(restarted.save({id:record.id,version:0,draft:draft()}),{status:409});assert.equal((await restarted.readState()).discardedIds.length,0);
  }
  await restarted.save({...await restarted.allocate(),draft:draft()});assert.equal((await store.read()).entries.length,0);
});
test('discard before first write prevents delayed recreation, including a lost successful save response',async t=>{
  const {drafts}=await fixture(t),{id}=await drafts.allocate(),request={id,version:0,draft:draft()};
  await drafts.remove({id,version:0});await assert.rejects(drafts.save(request),{status:409});assert.equal((await drafts.read()).length,0);
  const lost={...await drafts.allocate(),draft:draft()};await drafts.save(lost);await drafts.remove({...lost});await assert.rejects(drafts.save(lost),{status:409});assert.equal((await drafts.read()).length,0);
});
test('prepared intentions freeze edits and deletion; completed cleanup cannot reapply an addition',async t=>{
  const {dir,store,drafts}=await fixture(t),{id}=await drafts.allocate(),payload=intent();
  const record=await drafts.save({id,version:0,draft:draft(),intent:payload});
  assert.equal((await drafts.save({id,version:0,draft:draft(),intent:payload})).version,1);
  await assert.rejects(drafts.save({id,version:1,draft:draft()}),{status:409});
  await assert.rejects(drafts.remove({id,version:1,requestId:payload.requestId}),{status:409});
  await assert.rejects(drafts.assertIntent(id,{...payload,entry:{...payload.entry,title:'另一意图'}}),{status:409});
  assert.equal((await new EntryDraftStore(dir,store).assertIntent(id,payload)).id,record.id);
  await store.addEntry(payload);await drafts.remove({id,requestId:payload.requestId});assert.equal((await drafts.read()).length,0);
  assert.equal((await store.addEntry(payload)).replayed,true);assert.equal((await store.read()).entries.length,1);
});
test('draft limit, checksum and future formats fail closed without pruning user content',async t=>{
  const {dir,drafts}=await fixture(t);
  for(let index=0;index<MAX_ENTRY_DRAFTS;index++)await drafts.save({...await drafts.allocate(),draft:draft()});
  await assert.rejects(drafts.save({...await drafts.allocate(),draft:draft()}),{status:400});
  const path=join(dir,'entry-drafts.json'),raw=await readFile(path,'utf8'),value=JSON.parse(raw);value.items[0].draft.values.title='损坏后的值';await writeFile(path,JSON.stringify(value));
  await assert.rejects(drafts.read(),{status:503});await assert.rejects(drafts.save({id:randomUUID(),version:0,draft:draft()}),{status:503});assert.equal(await readFile(path,'utf8'),JSON.stringify(value));
});
test('HTTP preparation, rejection release and delayed stale requests never overwrite or duplicate',async t=>{
  const {dir}=await fixture(t),server=makeServer({dataDir:dir});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
  const api=async(path,body,method='POST')=>fetch(base+path,{method,headers,body:JSON.stringify(body)});
  const {id}=await(await api('/api/entry-drafts/allocate')).json(),payload={...intent(),draftId:id};
  assert.equal((await api('/api/entries/add',payload)).status,409);
  assert.equal((await api('/api/entry-drafts',{id,version:0,draft:draft(),intent:payload},'PUT')).status,200);
  assert.equal((await api('/api/entry-drafts/release',{id,requestId:payload.requestId})).status,200);
  assert.equal((await api('/api/entries/add',payload)).status,409);
  const library=await(await fetch(base+'/api/library',{headers})).json();assert.equal(library.entries.length,0);
  const next={...intent(),draftId:id};assert.equal((await api('/api/entry-drafts',{id,version:2,draft:draft(),intent:next},'PUT')).status,200);
  const added=await(await api('/api/entries/add',next)).json();assert.equal(added.state,'completed');assert.equal(added.library.entries.length,1);
  const retry=await(await api('/api/entries/add',next)).json();assert.equal(retry.replayed,true);
  assert.equal((await(await fetch(base+'/api/entry-drafts',{headers})).json()).drafts.length,0);
  assert.equal((await fetch(base+'/api/entry-drafts')).status,403);
  assert.equal((await fetch(base+'/api/entry-drafts/allocate',{method:'POST'})).status,403);
});
for(const fault of ['write','sync','rename','directory-sync','crash-before','crash-after'])test(`draft preparation ${fault}: restart reads only a complete record and retry keeps one intent`,async t=>{
  const {dir,store,drafts}=await fixture(t),request={...await drafts.allocate(),draft:draft(),intent:intent()};await writeFile(join(dir,'draft-request.json'),JSON.stringify(request));
  const result=await new Promise((resolve,reject)=>{
    const worker=spawn(process.execPath,[fileURLToPath(new URL('../scripts/storage-fault-worker.mjs',import.meta.url)),dir,'draft',fault],{stdio:['ignore','pipe','pipe']});let stderr='';worker.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(Error('Draft fault worker timed out'));},10000);
    worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr});});
  });
  assert.equal(result.stderr,'');if(fault.startsWith('crash'))assert.equal(result.signal,'SIGKILL');else assert.equal(result.code,71);
  const exists=['directory-sync','crash-after'].includes(fault);assert.equal((await drafts.read()).length,exists?1:0);assert.equal((await store.read()).entries.length,0);
  const restarted=new EntryDraftStore(dir,store),record=await restarted.save(request);assert.equal(record.version,1);assert.equal((await restarted.read()).length,1);assert.equal(record.intent.requestId,request.intent.requestId);
});
