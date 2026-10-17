import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {LibraryStore} from '../lib/store.mjs';
import {CoverCache} from '../lib/cover-cache.mjs';
import {MigrationCoordinator} from '../lib/migration.mjs';
import {makeServer} from '../server.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'fandu-snapshot-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new LibraryStore(dir);
  const first=await store.save({revision:0,entries:[{id:'snapshot',title:'星海巡航',type:'anime',note:'snapshot'}],settings:{theme:'cyan'}});
  const catalog=await store.createSnapshot();
  const selected=catalog.backups.find(item=>item.kind==='manual');
  await store.save({...first,entries:first.entries.map(item=>({...item,note:'before restore'})),settings:{...first.settings,theme:'blue'}});
  const value=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));
  await writeFile(join(dir,'library.json'),JSON.stringify({...value,unknownLocalField:'preserve verbatim'},null,2));
  const covers=new CoverCache(join(dir,'covers'));await covers.ready;
  const coordinator=new MigrationCoordinator({dir,store,covers});
  const current=await store.listBackups();
  const request={requestId:randomUUID(),id:selected.id,token:selected.token,currentToken:current.current.token};
  return {dir,store,covers,coordinator,request,before:await readFile(join(dir,'library.json'))};
}
async function worker(dir,fault){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/migration-fault-worker.mjs',import.meta.url)),dir,fault,'restore'],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Snapshot worker timed out'));},10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
}
test('snapshot creation retries one immutable copy even after later edits; deletion confirms absence',async t=>{
  const {dir,store}=await fixture(t),catalog=await store.listBackups();
  const request={requestId:randomUUID(),currentToken:catalog.current.token};
  await assert.rejects(store.createSnapshot({requestId:randomUUID()}),/确认版本无效/);
  const created=await store.createSnapshot(request),id=`manual-${request.requestId}.json`;
  const bytes=await readFile(join(dir,id));
  const latest=await store.read();await store.save({...latest,entries:latest.entries.map(item=>({...item,note:'later'}))});
  const repeated=await store.createSnapshot(request);
  assert.equal(repeated.backups.filter(item=>item.id===id).length,1);
  assert.deepEqual(await readFile(join(dir,id)),bytes);
  assert.equal(repeated.current.revision,latest.revision+1);
  await assert.rejects(store.createSnapshot({...request,currentToken:repeated.current.token}),error=>error.status===409);
  await assert.rejects(store.createSnapshot({requestId:randomUUID(),currentToken:catalog.current.token}),error=>error.status===409);
  const selected=created.backups.find(item=>item.id===id);
  await store.deleteBackup(selected);const again=await store.deleteBackup(selected);
  assert.equal(again.backups.some(item=>item.id===id),false);
  assert.deepEqual((await store.read()).entries.map(item=>item.note),['later']);
});
test('pending snapshot restoration blocks conflicting storage work until the same decision can finish',async t=>{
  const {dir,store,covers,request,before}=await fixture(t);let failing=true,wrote=false;
  const coordinator=new MigrationCoordinator({dir,store,covers,onStage:async stage=>{if(failing&&stage==='covers')throw Error('restore storage unavailable');}});
  await assert.rejects(coordinator.restore(request),error=>error.migrationPending&&error.status===503);
  assert.equal((await coordinator.status(request.requestId)).state,'pending');
  await assert.rejects(coordinator.run(async()=>{wrote=true;await store.createSnapshot();}),/restore storage unavailable/);
  assert.equal(wrote,false);assert.deepEqual(await readFile(join(dir,'library.json')),before);
  failing=false;const restored=await coordinator.restore(request);
  assert.equal(restored.replayed,true);assert.equal(restored.library.entries[0].note,'snapshot');
  assert.equal((await readdir(dir)).filter(name=>name.startsWith('recovery-')).length,1);
});
for(const state of ['ok','corrupt','newer','missing']){
  test(`durable snapshot restoration accepts ${state} primary, preserves exact bytes and cannot replay over later edits`,async t=>{
    const {dir,store,coordinator,request}=await fixture(t);
    if(state==='corrupt')await writeFile(join(dir,'library.json'),'unparseable original bytes');
    if(state==='newer')await writeFile(join(dir,'library.json'),JSON.stringify({formatVersion:999,revision:900,entries:[],future:'preserve'}));
    if(state==='missing')await unlink(join(dir,'library.json'));
    request.currentToken=(await store.listBackups()).current.token;
    const before=state==='missing'?null:await readFile(join(dir,'library.json'));
    const restored=await coordinator.restore(request);
    assert.equal(restored.library.entries[0].note,'snapshot');assert.equal(restored.library.settings.theme,'cyan');
    if(before===null)assert.equal(restored.preserved,null);
    else assert.deepEqual(await readFile(join(dir,restored.preserved)),before);
    const next=await coordinator.run(()=>store.save({...restored.library,entries:restored.library.entries.map(item=>({...item,note:'later'}))}));
    const replay=await coordinator.restore(request);
    assert.equal(replay.replayed,true);assert.equal(replay.library.revision,next.revision);assert.equal(replay.library.entries[0].note,'later');
    const status=await coordinator.status(request.requestId);
    assert.equal(status.state,'committed');assert.equal(status.result.kind,'restore');assert.equal(status.result.library.revision,next.revision);
    assert.equal((await readdir(dir)).filter(name=>name.startsWith('recovery-')).length,before===null?0:1);
    await assert.rejects(coordinator.restore({...request,currentToken:(await store.listBackups()).current.token}),error=>error.status===409);
    await assert.rejects(coordinator.import({requestId:request.requestId,revision:next.revision,entries:next.entries,settings:next.settings}),error=>error.status===409);
  });
}
test('stale snapshot or primary confirmation fails before journaling or writing protection files',async t=>{
  const {dir,store,coordinator,request,before}=await fixture(t);
  const names=await readdir(dir);
  await assert.rejects(coordinator.restore({...request,currentToken:'0'.repeat(64)}),error=>error.status===409);
  await assert.rejects(coordinator.restore({...request,token:'0'.repeat(64)}),error=>error.status===409);
  assert.deepEqual(await readdir(dir),names);assert.deepEqual(await readFile(join(dir,'library.json')),before);
  const chosen=JSON.parse(await readFile(join(dir,request.id),'utf8'));
  await writeFile(join(dir,request.id),JSON.stringify({...chosen,revision:chosen.revision+1}));
  await assert.rejects(coordinator.restore(request),error=>error.status===409);
  assert.equal((await readdir(dir)).includes('migration-pending.json'),false);
  assert.deepEqual(await readFile(join(dir,'library.json')),before);
});
for(const fault of ['prepared','covers','archive','receipt','journal-sync','archive-sync','receipt-rename']){
  test(`snapshot ${fault}: durable restoration completes after restart without duplicate protection or overwrite`,async t=>{
    const {dir,request,before}=await fixture(t);
    await writeFile(join(dir,'migration-input.json'),JSON.stringify(request));
    const stopped=await worker(dir,fault);
    if(['prepared','covers','archive','receipt'].includes(fault))assert.equal(stopped.signal,'SIGKILL',stopped.stderr);
    else assert.equal(stopped.code,71,stopped.stderr);
    if(['prepared','covers','journal-sync','archive-sync'].includes(fault))assert.deepEqual(await readFile(join(dir,'library.json')),before);
    const store=new LibraryStore(dir),covers=new CoverCache(join(dir,'covers'));await covers.ready;
    const coordinator=new MigrationCoordinator({dir,store,covers});
    await coordinator.run(async()=>{});
    if(fault==='journal-sync')assert.deepEqual(await readFile(join(dir,'library.json')),before,'Unpublished intent must not restore implicitly');
    const restored=await coordinator.restore(request),revision=restored.library.revision;
    assert.equal(restored.library.entries[0].note,'snapshot');
    assert.deepEqual(await readFile(join(dir,restored.preserved)),before);
    assert.equal((await readdir(dir)).filter(name=>name.startsWith('recovery-')).length,1);
    assert.equal((await readdir(dir)).includes('migration-pending.json'),false);
    assert.equal((await coordinator.restore(request)).library.revision,revision);
  });
}
test('snapshot HTTP serializes identical confirmations and rejects a stale second window',async t=>{
  const {dir,request,before}=await fixture(t);
  const server=makeServer({dataDir:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const results=await Promise.all([1,2].map(async()=>{
    const response=await post('/api/backups/restore',request);assert.equal(response.status,200);return response.json();
  }));
  assert.equal(results[0].library.revision,results[1].library.revision);
  assert.equal(results.filter(item=>item.replayed).length,1);
  assert.deepEqual(await readFile(join(dir,results[0].preserved)),before);
  assert.equal((await post('/api/backups/restore',{...request,requestId:randomUUID()})).status,409);
  const catalog=await (await fetch(base+'/api/backups',{headers})).json();
  assert.equal(catalog.backups.filter(item=>item.kind==='recovery').length,1);
  const create={requestId:randomUUID(),currentToken:catalog.current.token};
  for(const _ of [1,2])assert.equal((await post('/api/backups/create',create)).status,200);
  const selected=(await (await fetch(base+'/api/backups',{headers})).json()).backups.find(item=>item.id===`manual-${create.requestId}.json`);
  for(const _ of [1,2])assert.equal((await post('/api/backups/delete',selected)).status,200);
});
