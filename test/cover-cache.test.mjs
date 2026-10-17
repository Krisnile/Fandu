import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoverCache } from '../lib/cover-cache.mjs';
import { Images } from '../lib/sources.mjs';
import { makeServer } from '../server.mjs';
import { LibraryStore } from '../lib/store.mjs';
import { entry } from '../src/model.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const url = n => `https://lain.bgm.tv/pic/cover/m/persist-${n}.png`;

test('cover cache: survives a new process instance, keeps bounded LRU state, and repairs missing files', async () => {
  const dir = await mkdtemp(join(tmpdir(),'yingjian-cover-cache-'));
  const first = new CoverCache(dir,{maxItems:2,maxBytes:2*1024*1024});
  await first.set('source:'+url(0),{body:png,type:'image/png',time:Date.now()});
  await first.set('source:'+url(1),{body:Buffer.concat([png,Buffer.from('1')]),type:'image/png',time:Date.now()});
  assert.equal(first.bytes, png.length + png.length + 1);
  const second = new CoverCache(dir,{maxItems:2,maxBytes:2*1024*1024});
  const restored = await second.get('source:'+url(0));
  assert.equal(restored.type,'image/png'); assert.deepEqual(restored.body,png);
  await writeFile(join(dir,second.index.get(requireKey('source:'+url(0))).file),Buffer.from('broken'));
  assert.equal(await second.get('source:'+url(0)),null);
  assert.equal(second.bytes,png.length + 1);
  assert.ok(JSON.parse(await readFile(join(dir,'index.json'),'utf8')).items.length <= 2);
});

test('cover cache: Images uses persistent files as fresh hits and stale offline fallback without bypassing validation', async () => {
  const dir = await mkdtemp(join(tmpdir(),'yingjian-cover-image-'));
  let requests = 0;
  const firstCache = new CoverCache(dir);
  const first = new Images({diskCache:firstCache,request:async()=>{requests++;return new Response(png);}});
  const a = await first.load(url(0)); assert.equal(a.type,'image/png');
  await firstCache.tail;
  const secondCache = new CoverCache(dir);
  const second = new Images({diskCache:secondCache,request:async()=>{requests++;throw Error('offline');}});
  const b = await second.load(url(0)); assert.deepEqual(b.body,png); assert.equal(requests,1);
  await secondCache.tail;
  const stale = secondCache.index.get(requireKey('source:'+url(0))); stale.at = Date.now()-3600_001; await secondCache.saveIndex(); await secondCache.tail;
  const third = new Images({diskCache:new CoverCache(dir),request:async()=>{requests++;throw Error('offline');}});
  const c = await third.load(url(0)); assert.deepEqual(c.body,png); assert.equal(requests,2);
  await assert.rejects(third.load('https://127.0.0.1/private.png'),/不支持/);
});

test('cover cache: corrupt indexes and oversized entries fail closed and do not expose arbitrary files', async () => {
  const dir = await mkdtemp(join(tmpdir(),'yingjian-cover-invalid-'));
  await writeFile(join(dir,'index.json'),JSON.stringify({version:99,items:[{file:'../../secret',bytes:1,type:'image/png',at:Date.now()}]}));
  const cache = new CoverCache(dir); assert.equal(await cache.get('anything'),null); assert.equal(cache.bytes,0);
  await assert.rejects(async()=>new CoverCache(dir,{maxItems:0}),/配置无效/);
});

test('cover cache: an unavailable local cache never blocks a valid network cover', async () => {
  let calls = 0;
  const images = new Images({
    diskCache: { get: async () => { throw Error('read-only cache'); }, set: async () => { throw Error('read-only cache'); } },
    request: async () => { calls++; return new Response(png); }
  });
  const loaded = await images.load(url(9));
  assert.equal(loaded.type,'image/png'); assert.equal(calls,1);
});

test('cover cache: export and import provide a checksummed, URL-independent migration package', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(),'yingjian-cover-export-'));
  const source = new CoverCache(sourceDir);
  await source.set('source:'+url(0),{body:png,type:'image/png',time:Date.now()});
  const bundle = await source.exportBundle();
  assert.equal(bundle.app,'fandu-cover-cache'); assert.equal(bundle.entries.length,1); assert.match(bundle.checksum,/^[a-f0-9]{64}$/);
  const target = new CoverCache(await mkdtemp(join(tmpdir(),'yingjian-cover-import-')));
  const result = await target.importBundle(bundle);
  assert.deepEqual(result,{added:1,updated:0,bytes:png.length,items:1});
  assert.deepEqual((await target.get('source:'+url(0))).body,png);
  const tampered = {...bundle,entries:bundle.entries.map(x=>({...x,body:Buffer.from('tampered').toString('base64')}))};
  await assert.rejects(target.importBundle(tampered),/校验失败/);
  const malformed = {...bundle,checksum:bundle.checksum,entries:[{...bundle.entries[0],key:'not-a-cache-key'}]};
  await assert.rejects(target.importBundle(malformed),/校验失败/);
});

test('cover cache: removes entries and files that are not referenced by the library', async () => {
  const dir = await mkdtemp(join(tmpdir(),'yingjian-cover-prune-'));
  const cache = new CoverCache(dir);
  await cache.set('source:'+url(0),{body:png,type:'image/png',time:Date.now()});
  await cache.set('source:'+url(1),{body:png,type:'image/png',time:Date.now()});
  await writeFile(join(dir,`${'a'.repeat(64)}.png`),png);
  const result = await cache.pruneUnreferenced(['source:'+url(0)]);
  assert.equal(result.removed,2);
  assert.equal(result.items,1);
  assert.deepEqual((await cache.get('source:'+url(0))).body,png);
  assert.equal(await cache.get('source:'+url(1)),null);
  assert.equal((await readdir(dir)).filter(file => /^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(file)).length,1);
});

test('cover cache HTTP: transfer endpoints are same-origin protected and persist imported bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(),'yingjian-cover-http-'));
  const libraryStore = new LibraryStore(dir), initial = await libraryStore.read();
  await libraryStore.save({revision:initial.revision,entries:[entry({id:'bangumi:4',sourceId:'bangumi:4',title:'缓存作品',type:'anime',cover:url(4)})],settings:initial.settings});
  const source = new CoverCache(join(dir,'covers'));
  await source.set('source:'+url(4),{body:png,type:'image/png',time:Date.now()});
  const bundle = await source.exportBundle();
  const server = makeServer({dataDir:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections?.();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`, headers={'X-Yingjian':'1','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/covers/export')).status,403);
  const exported = await fetch(base+'/api/covers/export',{headers:{'X-Yingjian':'1'}}); assert.equal(exported.status,200);
  assert.equal((await exported.json()).entries.length,1);
  const imported = await fetch(base+'/api/covers/import',{method:'POST',headers,body:JSON.stringify(bundle)}); assert.equal(imported.status,200);
  assert.equal((await imported.json()).updated,1);
  assert.equal((await new CoverCache(join(dir,'covers')).get('source:'+url(4))).body.length,png.length);
  assert.equal((await fetch(base+'/api/covers/import',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(bundle)})).status,403);
});

// SHA-256 is intentionally duplicated only for test lookup; cache filenames remain an implementation detail.
import { createHash } from 'node:crypto';
function requireKey(key) { return createHash('sha256').update(key).digest('hex'); }
