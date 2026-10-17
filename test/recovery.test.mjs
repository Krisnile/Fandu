import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LibraryStore, MAX_MANUAL_SNAPSHOTS, LIBRARY_FORMAT_VERSION } from '../lib/store.mjs';
import { makeServer } from '../server.mjs';
import { entry } from '../src/model.js';

const item = entry({id:'recovery-test', title:'恢复测试', type:'anime', note:'第一版'});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'yingjian-recovery-'));
  const store = new LibraryStore(dir);
  await store.save({revision:0, entries:[item], settings:{theme:'cyan',columns:4}});
  await store.save({revision:1, entries:[{...item,note:'第二版'}], settings:{theme:'violet'}});
  return {dir,store};
}
function selection(catalog) {
  const backup = catalog.backups.find(x => x.id === 'backup-1.json');
  return {id:backup.id,token:backup.token,currentToken:catalog.current.token};
}

test('recovery: lists validated snapshots, restores entries and settings, preserves exact previous bytes, supports undo', async () => {
  const {dir,store} = await fixture();
  const before = await readFile(join(dir,'library.json'));
  const catalog = await store.listBackups();
  assert.equal(catalog.current.count,1); assert.equal(catalog.backups[0].count,1);
  const restored = await store.restore(selection(catalog));
  assert.equal(restored.library.entries[0].note,'第一版');
  assert.equal(restored.library.settings.theme,'cyan'); assert.equal(restored.library.settings.columns,4);
  assert.ok(restored.library.revision > 2);
  assert.deepEqual(await readFile(join(dir,restored.preserved)),before);
  assert.equal((await store.read()).revision,restored.library.revision);
  // Old windows cannot save over the restored archive.
  await assert.rejects(store.save({revision:2,entries:[]}), e => e.status === 409);
  const next = await store.listBackups(), protectedCopy = next.backups.find(x => x.id === restored.preserved);
  assert.equal(protectedCopy.kind,'recovery'); assert.equal(protectedCopy.state,'ok');
  const undo = await store.restore({id:protectedCopy.id,token:protectedCopy.token,currentToken:next.current.token});
  assert.equal(undo.library.entries[0].note,'第二版'); assert.equal(undo.library.settings.theme,'violet');
});

test('recovery: corrupt main archive is preserved verbatim; invalid snapshots cannot restore', async () => {
  const {dir,store} = await fixture();
  const corrupt = Buffer.from('{"broken":"未完成写入');
  await writeFile(join(dir,'library.json'),corrupt);
  await writeFile(join(dir,'backup-2.json'),'bad snapshot');
  await assert.rejects(store.read(),/无法读取/);
  const catalog = await store.listBackups();
  assert.equal(catalog.current.state,'corrupt');
  assert.equal(catalog.backups.find(x=>x.id==='backup-2.json').state,'corrupt');
  await assert.rejects(store.restore({...selection(catalog),id:'backup-2.json'}),/损坏/);
  const restored = await store.restore(selection(catalog));
  assert.deepEqual(await readFile(join(dir,restored.preserved)),corrupt);
  assert.equal((await store.read()).entries[0].note,'第一版');
  assert.equal((await store.listBackups()).backups.find(x=>x.id===restored.preserved).state,'corrupt');
});

test('recovery: a compatible snapshot can replace a newer archive while preserving its exact bytes', async () => {
  const {dir,store} = await fixture();
  const future = Buffer.from(JSON.stringify({formatVersion:LIBRARY_FORMAT_VERSION+1,revision:88,entries:[item],settings:{theme:'amber'}}));
  await writeFile(join(dir,'library.json'),future);
  await assert.rejects(store.read(),/升级番渡/);
  const catalog = await store.listBackups();
  assert.equal(catalog.current.state,'newer');
  assert.equal(catalog.current.formatVersion,LIBRARY_FORMAT_VERSION+1);
  const restored = await store.restore(selection(catalog));
  assert.deepEqual(await readFile(join(dir,restored.preserved)),future);
  assert.equal(restored.library.formatVersion,LIBRARY_FORMAT_VERSION);
  assert.equal((await store.read()).entries[0].note,'第一版');
});

test('recovery: changing the current archive or selected snapshot invalidates confirmation without creating files', async () => {
  const {dir,store} = await fixture();
  const old = selection(await store.listBackups());
  await store.save({revision:2,entries:[]});
  await assert.rejects(store.restore(old),e=>e.status===409);
  const changed = selection(await store.listBackups());
  await writeFile(join(dir,'backup-1.json'),JSON.stringify({revision:1,entries:[]}));
  await assert.rejects(store.restore(changed),e=>e.status===409);
  assert.equal((await readdir(dir)).filter(x=>x.startsWith('recovery-')).length,0);
  assert.equal((await store.read()).entries.length,0);
  for (const id of ['../library.json','library.json','backup-9.json','/tmp/backup-1.json']) await assert.rejects(store.restore({...changed,id}),/编号无效/);
});

test('recovery: snapshots can be deleted with a token but the final healthy copy is protected', async () => {
  const {dir,store} = await fixture();
  let catalog = await store.listBackups();
  const only = catalog.backups.find(x => x.id === 'backup-1.json');
  await assert.rejects(store.deleteBackup({id:only.id, token:only.token}), /最后一份/);
  await store.save({revision:2, entries:[item], settings:{theme:'cyan'}});
  catalog = await store.listBackups();
  const removable = catalog.backups.find(x => x.id === 'backup-1.json');
  const after = await store.deleteBackup({id:removable.id, token:removable.token});
  assert.equal(after.backups.some(x => x.id === removable.id), false);
  assert.equal((await store.read()).entries[0].id, item.id);
  assert.equal((await store.deleteBackup({id:removable.id,token:removable.token})).backups.some(item=>item.id===removable.id),false,'已删除版本再次删除应安全确认，不报不存在');
  await assert.rejects(store.deleteBackup({id:'../library.json', token:'x'}), /编号无效/);
  assert.equal((await readdir(dir)).includes(removable.id), false);
});

test('recovery: manual snapshots are separate, byte-preserving, bounded and manageable', async () => {
  const {dir,store} = await fixture();
  const before = await readFile(join(dir,'library.json'));
  const catalog = await store.createSnapshot();
  const manual = catalog.backups.find(x => x.kind === 'manual');
  assert.ok(manual?.id.startsWith('manual-'));
  assert.equal(manual.state,'ok');
  assert.equal(manual.count,1);
  assert.deepEqual(await readFile(join(dir,manual.id)),before);
  const refreshed = await store.listBackups();
  assert.equal(refreshed.limits.manual,MAX_MANUAL_SNAPSHOTS);
  const removed = await store.deleteBackup({id:manual.id,token:manual.token});
  assert.equal(removed.backups.some(x => x.id === manual.id),false);
  // The automatic archive remains independently available.
  assert.ok(refreshed.backups.some(x => x.kind === 'auto'));
  for (let i = 0; i < MAX_MANUAL_SNAPSHOTS; i++) await store.createSnapshot();
  await assert.rejects(store.createSnapshot(), new RegExp(`最多保留 ${MAX_MANUAL_SNAPSHOTS} 份`));
});

test('recovery: missing main with existing backups is read-only until explicit restoration', async () => {
  const {dir,store} = await fixture();
  await rename(join(dir,'library.json'),join(dir,'original-test-copy.json'));
  await assert.rejects(store.read(),/主档缺失/);
  await assert.rejects(store.save({revision:0,entries:[]}),/主档缺失/);
  const catalog = await store.listBackups(); assert.equal(catalog.current.state,'missing');
  const restored = await store.restore(selection(catalog));
  assert.equal(restored.preserved,null); assert.equal((await store.read()).entries.length,1);
});

test('recovery: concurrent requests serialize and protection cap fails closed', async () => {
  const {dir,store} = await fixture();
  const chosen = selection(await store.listBackups());
  const outcomes = await Promise.allSettled([store.restore(chosen),store.restore(chosen)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.find(x=>x.status==='rejected').reason.status,409);
  const before = await readFile(join(dir,'library.json'));
  assert.equal((await readdir(dir)).filter(x=>x.startsWith('recovery-')).length,1);
  for(let n=1;n<20;n++) await writeFile(join(dir,`recovery-00000000-0000-4000-8000-${String(n).padStart(12,'0')}.json`),before);
  await assert.rejects(store.restore(selection(await store.listBackups())),/20 份/);
  assert.deepEqual(await readFile(join(dir,'library.json')),before);
});

test('HTTP recovery: corrupt archive remains recoverable only through protected APIs, then survives a fresh store read', async t => {
  const {dir,store} = await fixture();
  await writeFile(join(dir,'library.json'),'corrupt');
  const server = makeServer({dataDir:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/backups')).status,403);
  assert.equal((await fetch(base+'/api/library',{headers})).status,400);
  const catalog=await (await fetch(base+'/api/backups',{headers})).json();
  const body=JSON.stringify(selection(catalog));
  assert.equal((await fetch(base+'/api/backups/restore',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body})).status,403);
  const restored=await fetch(base+'/api/backups/restore',{method:'POST',headers,body});
  assert.equal(restored.status,200);
  const result=await restored.json(); assert.ok(result.preserved);
  assert.equal((await fetch(base+`/data/${result.preserved}`)).status,404);
  assert.equal((await fetch(base+'/api/backups/restore',{method:'POST',headers,body})).status,409);
  assert.equal((await new LibraryStore(dir).read()).entries[0].note,'第一版');
  assert.equal((await store.listBackups()).current.state,'ok');
});
