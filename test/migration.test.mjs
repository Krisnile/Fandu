import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {LibraryStore} from '../lib/store.mjs';
import {CoverCache} from '../lib/cover-cache.mjs';
import {MigrationCoordinator} from '../lib/migration.mjs';
import {entry,preferences} from '../src/model.js';
import {makeServer} from '../server.mjs';
import {DataDirectoryLease} from '../lib/data-lease.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
const cover='https://lain.bgm.tv/pic/cover/l/migration.jpg';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'fandu-migration-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new LibraryStore(dir);
  await store.save({revision:0,entries:[{id:'migration',title:'迁移前',type:'anime',note:'before'}],settings:{theme:'blue'}});
  // Protect the exact raw bytes, including formatting and future unknown fields.
  const value=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));
  await writeFile(join(dir,'library.json'),JSON.stringify({...value,localUnknown:'preserve'},null,2));
  const before=await readFile(join(dir,'library.json'));
  const covers=new CoverCache(join(dir,'covers'));await covers.ready;
  const seed=new CoverCache(join(dir,'seed'));await seed.ready;
  await seed.set(`source:${cover}`,{body:png,type:'image/png'});
  const request={requestId:randomUUID(),revision:1,entries:[entry({id:'migration',title:'迁移后',type:'anime',note:'after',cover})],settings:{theme:'cyan'},covers:await seed.exportBundle()};
  await writeFile(join(dir,'migration-input.json'),JSON.stringify(request));
  return {dir,store,covers,request,before,coordinator:new MigrationCoordinator({dir,store,covers})};
}
async function worker(dir,fault){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/migration-fault-worker.mjs',import.meta.url)),dir,fault],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Migration worker timed out'));},10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
}
test('migration validates before journaling, preserves exact bytes, and never replays over later edits',async t=>{
  const {dir,store,request,before,coordinator}=await fixture(t);
  const damaged={...request,covers:{...request.covers,checksum:'broken'}};
  await assert.rejects(async()=>coordinator.import(damaged),/校验失败/);
  assert.deepEqual(await readFile(join(dir,'library.json')),before);
  assert.equal((await readdir(dir)).includes('migration-pending.json'),false);
  const result=await coordinator.import(request);
  assert.equal(result.library.revision,2);assert.equal(result.library.entries[0].note,'after');
  assert.deepEqual(await readFile(join(dir,result.preserved)),before);
  const latest=await coordinator.run(()=>store.save({...result.library,entries:result.library.entries.map(item=>({...item,note:'later edit'}))}));
  const replay=await coordinator.import(request);
  assert.equal(replay.replayed,true);assert.equal(replay.library.revision,latest.revision);assert.equal(replay.library.entries[0].note,'later edit');
  await assert.rejects(coordinator.import({...request,entries:request.entries.map(item=>({...item,note:'different intent'}))}),error=>error.status===409);
  assert.equal((await coordinator.status(request.requestId)).state,'committed');
});
for(const fault of ['prepared','covers','archive','receipt','journal-sync','cover-write','archive-sync','receipt-rename']){
  test(`migration ${fault}: restart resolves the durable decision without double archive writes`,async t=>{
    const {dir,request,before}=await fixture(t);
    const stopped=await worker(dir,fault);
    if(['prepared','covers','archive','receipt'].includes(fault))assert.equal(stopped.signal,'SIGKILL',stopped.stderr);
    else assert.equal(stopped.code,71,stopped.stderr);
    if(['prepared','covers','journal-sync','cover-write','archive-sync'].includes(fault))assert.deepEqual(await readFile(join(dir,'library.json')),before);
    const store=new LibraryStore(dir),covers=new CoverCache(join(dir,'covers'));await covers.ready;
    const coordinator=new MigrationCoordinator({dir,store,covers});
    await coordinator.run(async()=>{});
    if(fault==='journal-sync')assert.equal((await store.read()).revision,1,'No durable intent means no implicit import');
    const result=await coordinator.import(request);
    assert.equal(result.library.revision,2);assert.equal(result.library.entries[0].note,'after');
    assert.deepEqual((await covers.get(`source:${cover}`)).body,png);
    assert.deepEqual(await readFile(join(dir,result.preserved)),before);
    assert.equal((await readdir(dir)).filter(name=>name.startsWith('recovery-')).length,1);
    assert.equal((await readdir(dir)).includes('migration-pending.json'),false);
    assert.equal((await coordinator.import(request)).library.revision,2);
  });
}
test('migration blocks interleaved storage tasks while recovery is unresolved and rejects damaged journals',async t=>{
  const {dir,store,covers,request,before}=await fixture(t);
  let failing=true;
  const coordinator=new MigrationCoordinator({dir,store,covers,onStage:async stage=>{if(failing&&stage==='covers')throw Error('disk unavailable');}});
  await assert.rejects(coordinator.import(request),error=>error.migrationPending&&error.status===503);
  let wrote=false;
  await assert.rejects(coordinator.run(async()=>{wrote=true;}),/disk unavailable/);assert.equal(wrote,false);
  assert.equal((await coordinator.status(request.requestId)).state,'pending');
  assert.deepEqual(await readFile(join(dir,'library.json')),before);
  failing=false;await coordinator.run(async()=>{wrote=true;});assert.equal(wrote,true);
  assert.equal((await store.read()).revision,2);
  await writeFile(join(dir,'migration-pending.json'),'corrupt');
  const current=await readFile(join(dir,'library.json'));
  await assert.rejects(coordinator.run(()=>store.save({revision:2,entries:[]})),error=>error.status===503);
  assert.deepEqual(await readFile(join(dir,'library.json')),current);
  assert.equal(await readFile(join(dir,'migration-pending.json'),'utf8'),'corrupt');
});
test('migration HTTP routes are protected, serialized, and export a consistent archive with offline covers',async t=>{
  const {dir,request}=await fixture(t);
  const server=makeServer({dataDir:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/migrations/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})).status,403);
  assert.equal((await fetch(base+'/api/migrations/import',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(request)})).status,403);
  const imports=await Promise.all([1,2].map(()=>fetch(base+'/api/migrations/import',{method:'POST',headers,body:JSON.stringify(request)}).then(response=>response.json())));
  assert.deepEqual(imports.map(result=>result.library.revision),[2,2]);
  assert.equal(imports.filter(result=>result.replayed).length,1);
  const exported=await (await fetch(base+'/api/migrations/export',{method:'POST',headers,body:JSON.stringify({revision:2,includeCovers:true})})).json();
  assert.equal(exported.library.entries[0].note,'after');assert.equal(exported.covers.entries.length,1);
  assert.equal((await fetch(base+'/api/migrations/export',{method:'POST',headers,body:JSON.stringify({revision:1,includeCovers:true})})).status,409);
  const status=await (await fetch(base+'/api/migrations/status?id='+request.requestId,{headers})).json();assert.equal(status.state,'committed');
});
test('migration settings and retries with missing timestamps normalize identically',async t=>{
  assert.deepEqual(preferences(preferences()),preferences());
  const {coordinator,request}=await fixture(t);
  const plain={...request,entries:[{id:'plain',title:'没有时间戳的导入',type:'anime'}],covers:null};
  const saved=await coordinator.import(plain),replay=await coordinator.import(plain);
  assert.equal(saved.library.revision,2);assert.equal(replay.library.revision,2);assert.equal(replay.replayed,true);
});
test('migration can initialize an empty data directory without inventing a preserved archive',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fandu-migration-first-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new LibraryStore(dir),covers=new CoverCache(join(dir,'covers'));await covers.ready;
  const coordinator=new MigrationCoordinator({dir,store,covers});
  const request={requestId:randomUUID(),revision:0,entries:[{id:'first',title:'首个导入',type:'anime'}],settings:{},covers:null};
  const result=await coordinator.import(request);
  assert.equal(result.library.revision,1);assert.equal(result.preserved,null);
  assert.equal((await coordinator.import(request)).replayed,true);
  assert.equal((await readdir(dir)).some(name=>name.startsWith('recovery-')),false);
});
test('migration receipts stay bounded and an expired retry cannot reapply an old replacement',async t=>{
  const {coordinator,store,request}=await fixture(t);let revision=1;
  for(let index=0;index<22;index++){
    const value=index===0?request:{...request,requestId:randomUUID(),revision};
    const result=await coordinator.import(value);revision=result.library.revision;
    const catalog=await coordinator.run(()=>store.listBackups()),selected=catalog.backups.find(item=>item.id===result.preserved);
    await coordinator.run(()=>store.deleteBackup({id:selected.id,token:selected.token}));
  }
  assert.equal((await coordinator.receipts()).length,20);
  assert.equal((await coordinator.status(request.requestId)).state,'unknown');
  await assert.rejects(coordinator.import(request),error=>error.status===409);
  assert.equal((await store.read()).revision,revision);
});
test('migration HTTP pending recovery prevents archive and cover operations until it can finish',async t=>{
  const {dir,request,before}=await fixture(t);let failing=true;
  const server=makeServer({dataDir:dir,onMigrationStage:async stage=>{if(failing&&stage==='covers')throw Error('测试磁盘故障');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
  const response=await fetch(base+'/api/migrations/import',{method:'POST',headers,body:JSON.stringify(request)});
  assert.equal(response.status,503);assert.equal((await response.json()).migrationPending,true);
  for(const [path,method,body] of [['/api/library','GET'],['/api/library','PUT',{revision:1,entries:[]}],['/api/covers/prune','POST'],['/api/backups/create','POST']]){
    assert.equal((await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})})).status,503);
  }
  assert.deepEqual(await readFile(join(dir,'library.json')),before);
  assert.equal((await (await fetch(base+'/api/migrations/status?id='+request.requestId,{headers})).json()).state,'pending');
  failing=false;
  const confirmed=await (await fetch(base+'/api/migrations/status?id='+request.requestId,{headers})).json();
  assert.equal(confirmed.state,'committed');assert.equal(confirmed.result.library.revision,2);
  assert.equal((await fetch(base+'/api/library',{headers})).status,200);
});
test('server shutdown retains the data lease while a disconnected migration is still writing',{timeout:10000},async t=>{
  const {dir,request}=await fixture(t);let release,reached;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{reached=resolve;});
  const server=makeServer({dataDir:dir,onMigrationStage:async stage=>{if(stage==='prepared'){reached();await gate;}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const controller=new AbortController(),base=`http://127.0.0.1:${server.address().port}`;
  const response=fetch(base+'/api/migrations/import',{method:'POST',headers:{'X-Yingjian':'1','Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal}).catch(error=>error);
  await started;controller.abort();assert.equal((await response).name,'AbortError');
  let closed=false;const closing=new Promise(resolve=>server.close(()=>{closed=true;resolve();}));
  try{
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(closed,false);
    const other=new DataDirectoryLease(dir);await assert.rejects(other.acquire(),error=>error.code==='FANDU_DATA_IN_USE');
  }finally{release();}
  await closing;
  const next=new DataDirectoryLease(dir);await next.acquire();await next.release();
  assert.equal((await new LibraryStore(dir).read()).revision,2);
});
