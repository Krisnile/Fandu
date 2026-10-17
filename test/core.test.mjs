import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { entry, validateLibrary, imageUrl, customImageUrl, safeSourceUrl, preferences, pageLayout, MAX_LISTS, MAX_MANAGED_TAGS, MAX_ENTRY_TAGS, MAX_SERIES } from '../src/model.js';
import { publicAddress, resolvePublicImage, customImageBody } from '../lib/custom-images.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { fuzzySearch } from '../src/search.js';
import { LibraryStore, LIBRARY_FORMAT_VERSION } from '../lib/store.mjs';
import { Sources, LRU, boundedBody, mapAnnXml, mapJikan, mapKitsu, mapWikiSearch, mapWikidataSearch, mapBangumi, mapTmdb, mapTvmaze } from '../lib/sources.mjs';
import { SourceIconCache, SOURCE_ICON_URLS } from '../lib/source-icons.mjs';
import { makeServer, resolveDataDirectory } from '../server.mjs';
import { loadProjectEnvironment } from '../lib/data-path.mjs';
import { request as httpRequest } from 'node:http';
import { createBackup, createTransferBundle, parseBackup, parseBackupBundle, parsePortableBundle, mergeBackup } from '../src/backup.js';
const sample=entry({id:'a',title:'葬送的芙莉莲',originalTitle:'Sousou no Frieren',aliases:['Frieren','furilian'],type:'anime',genres:['治愈'],total:28,progress:2});

test('data directory configuration has a stable default and resolves portable paths',()=>{
  const appRoot = resolve('test-app-root'), absolute = resolve('portable-absolute');
  assert.equal(resolveDataDirectory({env:{},appRoot}),join(appRoot,'data'));
  assert.equal(resolveDataDirectory({env:{FANDU_DATA_DIR:' portable/archive '},appRoot}),join(appRoot,'portable/archive'));
  assert.equal(resolveDataDirectory({env:{FANDU_DATA_DIR:absolute},appRoot}),absolute);
  assert.equal(resolveDataDirectory({env:{FANDU_DATA_DIR:'   '},appRoot}),join(appRoot,'data'));
});

test('project environment loading ignores a missing file but surfaces real read failures',()=>{
  const missing = Object.assign(Error('missing'), {code:'ENOENT'});
  const denied = Object.assign(Error('denied'), {code:'EACCES'});
  assert.equal(loadProjectEnvironment({envFile:'/missing/.env',load:()=>{throw missing;}}),false);
  assert.equal(loadProjectEnvironment({envFile:'/available/.env',load:path=>assert.equal(path,'/available/.env')}),true);
  assert.throws(()=>loadProjectEnvironment({envFile:'/denied/.env',load:()=>{throw denied;}}),error=>error===denied);
});

test('custom covers: public HTTPS, private and rebinding protection, pinned connection, limits',async()=>{
  assert.ok(customImageUrl('https://images.example.com/cover.png?v=2'));
  for(const url of ['http://images.example.com/a.jpg','https://127.0.0.1/a','https://2130706433/a','https://[::1]/a','https://nas.local/a','https://private.internal/a','https://x.example.com:8443/a','https://cdn.aqdstatic.com:967/age/a.jpg','https://cdn.aqdstatic.com:966/private/a.jpg','https://u:p@x.example.com/a','data:image/png,AA','https://x.example.com/a#token']) assert.equal(customImageUrl(url),'',url);
  assert.ok(customImageUrl('https://cdn.aqdstatic.com:966/age/20180134.jpg'));
  for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.100.100.200','0.0.0.0','224.0.0.1','198.18.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
  assert.ok(publicAddress('8.8.8.8'));assert.ok(publicAddress('2606:4700:4700::1111'));
  await assert.rejects(()=>resolvePublicImage('https://images.example.com/a',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/阻止/);
  const resolver=async()=>[{address:'8.8.8.8',family:4}];
  const fake=(status,body,length)=> (_url,options,callback)=>{
    assert.equal(options.agent,false);assert.equal(options.autoSelectFamily,false);
    options.lookup('images.example.com',{},(err,ip,family)=>{assert.equal(err,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
    const req=new EventEmitter();
    const res=new PassThrough();res.statusCode=status;res.headers={'content-length':length||body.length};callback(res);if(!res.destroyed)res.end(body);
    return req;
  };
  assert.equal((await customImageBody('https://images.example.com/a',{resolver,request:fake(200,'png')})).toString(),'png');
  await assert.rejects(()=>customImageBody('https://images.example.com/a',{resolver,request:fake(302,'')}),/跳转/);
  await assert.rejects(()=>customImageBody('https://images.example.com/a',{resolver,request:fake(200,'x',3*1024*1024)}),/2 MB/);
});

test('manual source links stay public, explicit and safe',()=>{
  const linked=entry({...sample,id:'manual-source',sourceUrl:'https://bgm.tv/ep/7535'});
  assert.equal(linked.sourceUrl,'https://bgm.tv/ep/7535');
  assert.equal(safeSourceUrl('http://bgm.tv/ep/7535'),'');
  assert.equal(safeSourceUrl('https://bgm.tv/ep/7535?token=private'),'');
});

test('layout pagination preserves all items and safely adapts narrow screens',()=>{
  assert.deepEqual(preferences({columns:99,rows:-2}).columns,6); assert.deepEqual(preferences({columns:99,rows:-2}).rows,0);
  const settings={columns:5,rows:2}, seen=[];
  for(let page=1;page<=3;page++){
    const layout=pageLayout(23,settings,1000,page);
    assert.equal(layout.columns,5);assert.equal(layout.pages,3);
    seen.push(...Array.from({length:Math.min(layout.pageSize,23-layout.start)},(_,n)=>layout.start+n));
  }
  assert.equal(new Set(seen).size,23);
  assert.equal(pageLayout(23,settings,358).columns,2);
  assert.equal(pageLayout(0,settings,358,9).page,1);
  assert.equal(pageLayout(23,{columns:3,rows:0},1000).pages,1);
});
test('responsive pagination keeps a focused record on screen without changing ordinary navigation',()=>{
  for(const view of ['grid','list'])for(const rows of [0,1,2,6])for(const width of [180,358,660,1000])for(let index=0;index<23;index++){
    const layout=pageLayout(23,{columns:6,rows,view},width,1,index);
    assert.ok(index>=layout.start&&index<layout.start+layout.pageSize);
    assert.ok(layout.page>=1&&layout.page<=layout.pages);
  }
  assert.equal(pageLayout(23,{columns:6,rows:1},660,1,5).page,2);
  assert.equal(pageLayout(23,{columns:6,rows:1},1000,2,5).page,1);
  for(const index of [-1,23,NaN,1.5,'5'])assert.equal(pageLayout(23,{columns:6,rows:1},660,3,index).page,3);
  assert.equal(pageLayout(0,{columns:6,rows:1},358,9,0).page,1);
});
test('canvas preferences keep dense layouts within the practical ten-column range',()=>{
  assert.equal(preferences({}).columns,6);
  assert.equal(preferences({columns:1}).columns,6);
  assert.equal(preferences({columns:3}).columns,6);
  assert.equal(preferences({columns:6,rows:6}).columns,6);
  assert.equal(preferences({columns:8,rows:8}).columns,8);
  assert.equal(preferences({columns:10,rows:8}).columns,10);
  assert.equal(preferences({columns:11,rows:8}).columns,6);
  assert.equal(preferences({columns:8,rows:8}).rows,0);
  assert.equal(pageLayout(23,{columns:6,rows:2,view:'list'},1000).columns,1);
});

test('settings normalize duplicate navigation labels and retain one collection root',()=>{
  const prefs=preferences({lists:[{id:'library',label:'收藏',kind:'all'},{id:'x',label:'自定义',kind:'custom'},{id:'y',label:'自定义',kind:'custom'},{id:'x',label:'另一个',kind:'custom'}],series:[{id:'s1',label:'同一系列'},{id:'s2',label:'同一系列'},{id:'s1',label:'另一个名称'}]});
  assert.equal(prefs.lists.length,2); assert.equal(prefs.lists[0].label,'收藏'); assert.equal(prefs.lists[1].label,'自定义');
  assert.equal(prefs.series.length,1); assert.equal(prefs.series[0].label,'同一系列');
  const repaired=preferences({lists:[{id:'library',label:'收藏',kind:'all'},{id:'watching',label:'想看',kind:'status',status:'watching'},{id:'planned',label:'在看',kind:'status',status:'planned'}]});
  assert.deepEqual(repaired.lists.map(x=>x.label),['收藏','在看','想看']);
  const fallback=preferences({lists:[]}); assert.equal(fallback.lists.length,1); assert.equal(fallback.lists[0].id,'library');
  assert.equal(fallback.sourceEnabled.kitsu, true);
  const many=preferences({lists:Array.from({length:MAX_LISTS+4},(_,i)=>({id:`list-${i}`,label:`列表 ${i}`,kind:i?'custom':'all'}))});
  assert.equal(many.lists.length,MAX_LISTS);
  assert.equal(preferences({tags:Array.from({length:MAX_MANAGED_TAGS+4},(_,i)=>`标签 ${i}`)}).tags.length,MAX_MANAGED_TAGS);
  assert.equal(preferences({series:Array.from({length:MAX_SERIES+4},(_,i)=>({id:`series-${i}`,label:`系列 ${i}`}))}).series.length,MAX_SERIES);
  assert.equal(preferences({series:[{id:'a',label:'Fate Series'},{id:'b',label:'Ｆａｔｅ　Ｓｅｒｉｅｓ'}]}).series.length,1);
});

test('migration includes custom covers and layout, supports v1, and persists restoration',async()=>{
  const custom=entry({...sample,customCover:'https://images.example.com/a.png'});
  const backup=await createBackup([custom],{columns:4,rows:3});
  assert.equal(backup.app,'fandu');
  assert.equal(backup.version,3);
  assert.equal(Object.hasOwn(backup.entries[0],'sourceUrl'),false);
  const bundle=await parseBackupBundle(JSON.stringify(backup));
  assert.equal(bundle.entries[0].customCover,custom.customCover);
  assert.equal(bundle.settings.columns,4); assert.equal(bundle.settings.rows,3);
  const coverPayload={app:'fandu-cover-cache',version:1,exportedAt:'2026-09-27T00:00:00.000Z',entries:[]};
  const covers={...coverPayload,checksum:createHash('sha256').update(JSON.stringify(coverPayload)).digest('hex')};
  const transfer=await createTransferBundle([custom],{columns:4,rows:3},covers);
  const portable=await parsePortableBundle(JSON.stringify(transfer));
  assert.equal(portable.kind,'transfer');assert.equal(portable.coverCount,0);assert.equal(portable.covers.app,'fandu-cover-cache');
  assert.equal(portable.entries[0].customCover,custom.customCover);assert.equal(portable.settings.columns,4);
  const tamperedTransfer=structuredClone(transfer);tamperedTransfer.library.entries[0].title='被篡改';
  await assert.rejects(parsePortableBundle(JSON.stringify(tamperedTransfer)),/迁移包校验失败/);
  assert.equal((await parsePortableBundle(JSON.stringify(backup))).kind,'backup');
  const legacy={app:'yingjian',version:1,exportedAt:'2025-01-01',entries:[sample]};
  const checksum=createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal((await parseBackupBundle(JSON.stringify({...legacy,checksum}))).settings,null);
  const dir=await mkdtemp(join(tmpdir(),'yingjian-migration-')),store=new LibraryStore(dir);
  await store.save({revision:0,entries:[{...sample,note:'current'}],settings:{columns:2,rows:1}});
  await store.save({revision:1,...bundle});
  assert.equal((await new LibraryStore(dir).read()).settings.columns,bundle.settings.columns); assert.equal((await new LibraryStore(dir).read()).settings.rows,bundle.settings.rows);
  assert.equal((await new LibraryStore(dir).read()).entries[0].customCover,custom.customCover);
  const linked=entry({...sample,id:'linked-source',sourceUrl:'https://bgm.tv/ep/7535'});
  const linkedBackup=await createBackup([linked]);
  assert.equal(linkedBackup.entries[0].sourceUrl,'https://bgm.tv/ep/7535');
  assert.equal((await parseBackup(JSON.stringify(linkedBackup)))[0].sourceUrl,'https://bgm.tv/ep/7535');
  assert.equal(JSON.parse(await readFile(join(dir,'backup-1.json'),'utf8')).entries[0].note,'current');
  await store.save({revision:2,entries:[]});
  assert.equal((await store.read()).settings.columns,bundle.settings.columns); assert.equal((await store.read()).settings.rows,bundle.settings.rows);
});

test('fuzzy search: aliases, typos, transposition, Chinese, compound filters; disjoint text is excluded',()=>{
  const other=entry({id:'b',title:'银翼杀手 2049',type:'movie',originalTitle:'Blade Runner 2049'});
  const noisy=entry({id:'noise',title:'忍者与杀手二人组的日常生活',type:'anime'});
  for(const q of ['芙莉莲','芙利莲','Friren','Frierne','furilian','治愈 芙莉莲']) assert.equal(fuzzySearch([sample,other],q)[0]?.entry.id,'a',q);
  assert.equal(fuzzySearch([sample,other],'銀翼殺手')[0]?.entry.id,'b');
  assert.equal(fuzzySearch([noisy],'银翼杀手').length,0);
  assert.equal(fuzzySearch([noisy],'SEVERANCE').length,0);
  assert.equal(fuzzySearch([sample,other],'完全不存在的电影名称').length,0);
  assert.equal(fuzzySearch([sample],'芙莉莲',{type:'movie'}).length,0);
  const long=entry({id:'long',title:'x'.repeat(100),type:'tv'});
  assert.equal(fuzzySearch([long],'z'.repeat(100)).length,0);
  const importedLate=entry({...sample,id:'imported-late',title:'同分作品',year:2024,airedAt:'2024-01-01T00:00:00Z',updatedAt:'2026-09-01'});
  const premieredLate=entry({...sample,id:'premiered-late',title:'同分作品',year:2026,airedAt:'2026-01-01T00:00:00Z',updatedAt:'2024-01-01'});
  assert.equal(fuzzySearch([importedLate,premieredLate],'同分作品')[0].entry.id,'premiered-late');
});
test('user tags stay separate from provider genres and survive sparse backup',async()=>{
  const tagged=entry({...sample,id:'tagged',tags:['补番'],genres:['治愈']});
  assert.deepEqual(tagged.tags,['补番']);
  assert.equal(entry({...sample,id:'tag-limit',tags:Array.from({length:MAX_ENTRY_TAGS+3},(_,i)=>`标签 ${i}`)}).tags.length,MAX_ENTRY_TAGS);
  assert.deepEqual(tagged.genres,['治愈']);
  assert.equal(fuzzySearch([tagged],'补番')[0]?.entry.id,'tagged');
  const backup=await createBackup([tagged]);
  const restored=await parseBackup(JSON.stringify(backup));
  assert.deepEqual(restored[0].tags,['补番']);
  assert.deepEqual(restored[0].genres,['治愈']);
});
test('import validation and URL policy reject duplicates and untrusted images',()=>{
  assert.throws(()=>validateLibrary([sample,sample]));
  assert.throws(()=>entry({id:'x',title:'ok',type:'script'}));
  assert.throws(()=>validateLibrary(Array(2001).fill(sample)));
  for(const url of ['http://lain.bgm.tv/pic/a.jpg','https://lain.bgm.tv.evil.test/pic/a.jpg','https://user@lain.bgm.tv/pic/a.jpg','http://127.0.0.1/private','data:image/svg+xml,<svg/>','https://lain.bgm.tv:444/pic/a.jpg']) assert.equal(imageUrl(url),'');
  assert.ok(imageUrl('https://lain.bgm.tv/pic/cover/m/a.jpg'));
  assert.ok(imageUrl('https://lain.bgm.tv/r/400/pic/cover/l/a.jpg'));
  assert.ok(imageUrl('https://images1.myanimelist.net/images/anime/1/cover.jpg'));
  assert.ok(imageUrl('https://cdn.animenewsnetwork.com/encyclopedia/images/1/cover.jpg'));
  assert.ok(imageUrl('https://i0.hdslb.com/bfs/new_dyn/cover.jpg'));
  assert.equal(imageUrl('https://i0.hdslb.com/evil/cover.jpg'),'');
  const safe=entry({...sample,cover:'javascript:alert(1)',palette:['red; color:red','invalid'],progress:99});
  assert.equal(safe.cover,'');assert.equal(safe.progress,28);assert.deepEqual(safe.palette,['#6f8580','#263e42']);
});
test('atomic persistence, conflict detection, bounded backups and fail-closed corrupt data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'yingjian-store-test-')), store=new LibraryStore(dir);
  assert.deepEqual((await store.read()).entries,[]); assert.equal((await store.read()).revision,0); assert.equal((await store.read()).settings.columns,6); assert.equal((await store.read()).formatVersion,LIBRARY_FORMAT_VERSION);
  await store.save({revision:0,entries:[sample]});
  assert.equal(JSON.parse(await readFile(join(dir,'library.json'),'utf8')).formatVersion,LIBRARY_FORMAT_VERSION);
  const competing=await Promise.allSettled([store.save({revision:1,entries:[{...sample,note:'one'}]}),store.save({revision:1,entries:[{...sample,note:'two'}]})]);
  assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(competing.find(x=>x.status==='rejected').reason.status,409);
  for(let revision=2;revision<7;revision++) await store.save({revision,entries:[sample]});
  assert.equal((await readdir(dir)).filter(x=>x.startsWith('backup-')).length,3);
  const restored=new LibraryStore(dir);assert.equal((await restored.read()).revision,7);
  await writeFile(join(dir,'library.json'),'{corrupt');
  await assert.rejects(()=>store.save({revision:7,entries:[]}));
  assert.equal(await readFile(join(dir,'library.json'),'utf8'),'{corrupt');
});

test('legacy archives migrate on save while newer archives stay byte-for-byte read-only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fandu-format-test-')), path=join(dir,'library.json'), store=new LibraryStore(dir);
  await writeFile(path,JSON.stringify({revision:7,entries:[sample],settings:{theme:'cyan'}}));
  const legacy=await store.read();
  assert.equal(legacy.formatVersion,LIBRARY_FORMAT_VERSION);assert.equal(legacy.revision,7);
  await store.save({revision:legacy.revision,entries:legacy.entries,settings:legacy.settings});
  assert.equal(JSON.parse(await readFile(path,'utf8')).formatVersion,LIBRARY_FORMAT_VERSION);

  const future=JSON.stringify({formatVersion:LIBRARY_FORMAT_VERSION+1,revision:99,entries:[sample],settings:{theme:'violet'}});
  await writeFile(path,future);
  await assert.rejects(store.read(),/高于当前支持/);
  await assert.rejects(store.save({revision:99,entries:[]}),/升级番渡/);
  assert.equal(await readFile(path,'utf8'),future);
  const catalog=await store.listBackups();
  assert.equal(catalog.current.state,'newer');assert.equal(catalog.current.formatVersion,LIBRARY_FORMAT_VERSION+1);
});
test('sources: independent failures, request deduplication, and fallback cache',async()=>{
  let calls=0;
  const source=new Sources({request:async(url)=>{calls++;if(url.includes('tvmaze'))throw Error('offline');return {data:[{id:123,type:2,name:'Test',name_cn:'测试作品',date:'2024-04-01',images:{},eps:12}]};}});
  const [a,b]=await Promise.all([source.search('bangumi','test'),source.search('bangumi','test')]);
  assert.equal(calls,1);assert.equal(a.results[0].season,'春');assert.deepEqual(a,b);
  assert.equal((await source.search('tvmaze','test')).state,'unavailable');
  await assert.rejects(()=>source.search('tmdb','test'),/未知数据源/);
  const cached=source.cache.get('bangumi:all:test');cached.time-=16*60_000;
  source.request=async()=>{throw Error('network disconnected');};
  assert.equal((await source.search('bangumi','test')).state,'stale');
  assert.equal(source.health.bangumi.state,'unavailable');
  const kitsu = new Sources({request:async()=>({data:[{id:'99',type:'anime',attributes:{canonicalTitle:'动画电影',titles:{zh_cn:'动画电影'},showType:'movie',startDate:'2023-07-01',coverImage:{}}}]})});
  const kitsuResult = await kitsu.search('kitsu','动画电影','all');
  assert.equal(kitsuResult.state,'ok'); assert.equal(kitsuResult.results[0].type,'movie'); assert.equal(kitsu.health.kitsu.state,'ok');
});
test('image and search cache stay bounded; upstream body limits enforced',async()=>{
  const cache=new LRU(3,100);for(let i=0;i<20;i++)cache.set(String(i),{body:Buffer.alloc(30)});
  assert.ok(cache.bytes<=100);assert.ok(cache.map.size<=3);
  await assert.rejects(()=>boundedBody(new Response('x'.repeat(20)),10));
  assert.equal((await boundedBody(new Response('abc'),10)).toString(),'abc');
});
test('backup round trip, damaged-file rejection, non-destructive merge',async()=>{
  const backup=await createBackup([sample]);
  const imported=await parseBackup(JSON.stringify(backup));
  assert.deepEqual(imported,[sample]);
  const existing={...sample,note:'最新笔记'};
  const merged=mergeBackup([existing],imported);
  assert.equal(merged.added,0);assert.equal(merged.skipped,1);assert.equal(merged.entries[0].note,'最新笔记');
  backup.entries[0].title='损坏后的名称';
  await assert.rejects(()=>parseBackup(JSON.stringify(backup)),/校验失败/);
  await assert.rejects(()=>parseBackup('{bad JSON'));
});
test('provider metadata maps movie, TV, and anime without inventing episode totals',()=>{
  assert.equal(mapTvmaze({id:3,name:'Test',type:'Scripted',premiered:'2020-01-02'}).total,null);
  assert.equal(mapTvmaze({id:3,name:'Test',type:'Scripted',premiered:'2020-01-02'}).airedAt,'2020-01-02T00:00:00.000Z');
  assert.equal(mapTmdb({id:4,title:'Film',media_type:'movie',release_date:'2021-03-04'}).total,1);
  assert.equal(mapTmdb({id:4,title:'Film',media_type:'movie',release_date:'2021-03-04'}).airedAt,'2021-03-04T00:00:00.000Z');
  assert.equal(mapBangumi({id:5,type:2,name:'Anime',nsfw:true}),null);
  assert.equal(mapBangumi({id:6,type:6,name:'Film',platform:'电影'}).type,'movie');
  const kitsu=mapKitsu({id:'21',type:'anime',attributes:{canonicalTitle:'测试动画',titles:{ja_jp:'テストアニメ',en_jp:'Test Anime'},showType:'TV',episodeCount:24,startDate:'2024-04-01',averageRating:'83.0',synopsis:'<b>简介</b>',coverImage:{large:'https://media.kitsu.io/anime/poster_images/21/large.jpg'},abbreviatedTitles:['测试番'],genres:[{name:'Action'}]}});
  assert.equal(kitsu.type,'anime'); assert.equal(kitsu.title,'测试动画'); assert.equal(kitsu.total,24); assert.equal(kitsu.season,'春'); assert.equal(kitsu.airedAt,'2024-04-01T00:00:00.000Z'); assert.equal(kitsu.score,8.3); assert.equal(kitsu.cover,'https://media.kitsu.io/anime/poster_images/21/large.jpg');
  const localizedKitsu=mapKitsu({id:'23',attributes:{canonicalTitle:'Romanized Title',titles:{zh_cn:'中文标题',ja_jp:'日文标题'},showType:'TV',startDate:'2024-04-01'}});
  assert.equal(localizedKitsu.title,'中文标题'); assert.ok(localizedKitsu.aliases.includes('Romanized Title'));
  assert.equal(mapKitsu({id:'22',attributes:{canonicalTitle:'Movie',showType:'movie',startDate:'2023-07-01',coverImage:{}}}).type,'movie');
  const jikan=mapJikan({mal_id:31,title:'测试番',titles:{japanese:'テスト'},type:'TV',episodes:12,aired:{from:'2024-04-01'},images:{jpg:{large_image_url:'https://images1.myanimelist.net/images/anime/31/cover.jpg'}},score:8.1});
  assert.equal(jikan.type,'anime'); assert.equal(jikan.total,12); assert.equal(jikan.season,'春'); assert.equal(jikan.airedAt,'2024-04-01T00:00:00.000Z'); assert.equal(jikan.cover,'https://images1.myanimelist.net/images/anime/31/cover.jpg');
  assert.equal(mapWikiSearch({title:'测试电影',snippet:'简介'},'movie').type,'movie');
  assert.equal(mapWikiSearch({title:'测试电影',snippet:'简介'},'movie').sourceUrl,`https://zh.wikipedia.org/wiki/${encodeURIComponent('测试电影')}`);
  assert.equal(mapWikidataSearch({id:'Q42',label:'测试资料',description:'描述'},'tv').type,'tv');
  assert.equal(mapWikidataSearch({id:'Q42',label:'测试资料',description:'描述'},'tv').sourceUrl,'https://www.wikidata.org/wiki/Q42');
  const ann=mapAnnXml('<anime id="77" type="Movie"><info type="Main title">测试动画电影</info><info type="Plot Summary">简介</info></anime>');
  assert.equal(ann[0].sourceId,'ann:77'); assert.equal(ann[0].type,'movie');
});
test('encyclopedia search keeps media entries and drops unrelated knowledge pages',async()=>{
  const source = new Sources({request: async url => {
    if (url.includes('wikipedia')) return { query: { search: [
      { title:'海', snippet:'海是由大量鹹水組成的水體。' },
      { title:'海街日记', snippet:'2015年日本剧情电影。' },
      { title:'海瑞', snippet:'中华人民共和国退役足球运动员。' }
    ] } };
    return { search: [
      { id:'Q1', label:'海', description:'較大面積的鹹水區域' },
      { id:'Q2', label:'海月姬', description:'日本漫画作品及动画改编' },
      { id:'Q3', label:'海地', description:'中美洲国家' },
      { id:'Q4', label:'演员海', description:'film actor and singer' }
    ] };
  }});
  const wiki = await source.search('wikipedia','海');
  assert.deepEqual(wiki.results.map(x=>x.title),['海街日记']);
  const wikidata = await source.search('wikidata','海');
  assert.deepEqual(wikidata.results.map(x=>x.title),['海月姬']);
});
test('source catalog exposes at least ten usable defaults and per-source probes',async()=>{
  const probes=[];
  const source=new Sources({request:async()=>({}),requestText:async()=>'<anime/>',probe:async url=>{probes.push(url);return {ok:true};}});
  assert.ok(Object.keys(source.health).length >= 10);
  assert.equal((await source.check('douban')).state,'ok');
  assert.equal((await source.check('ann')).state,'ok');
  assert.equal((await source.search('yuc','季度')).state,'site_only');
  await assert.rejects(()=>source.check('tmdb'),/未知数据源/);
  assert.equal(probes.length,1);
});
test('Yuc source icon points to the official first-party asset',()=>{
  assert.equal(SOURCE_ICON_URLS.yuc,'https://yuc.wiki/images/32x32.png');
});
test('source icons warm once, persist locally, and back off after failure',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fandu-source-icons-')), png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  let calls=0;
  const cache=new SourceIconCache(dir,{sources:{sample:'https://icons.example/sample.png'},request:async()=>{calls++;return new Response(png,{headers:{'content-type':'image/png'}});}});
  const first=await Promise.all([cache.get('sample'),cache.get('sample')]);
  assert.equal(first[0].type,'image/png'); assert.equal(first[0].fallback,false); await cache.warm('sample'); assert.equal(calls,1);
  const reloaded=new SourceIconCache(dir,{sources:{sample:'https://icons.example/sample.png'},request:async()=>{throw Error('network');}});
  const stored=await reloaded.get('sample'); assert.equal(stored.type,'image/png'); assert.equal(stored.cached,true);
  let refreshedCalls=0;
  const refreshed=new SourceIconCache(dir,{sources:{sample:'https://icons.example/sample-v2.png'},request:async()=>{refreshedCalls++;return new Response(png,{headers:{'content-type':'image/png'}});}});
  await refreshed.warm('sample'); assert.equal(refreshedCalls,1);
  let failedCalls=0;
  const failed=new SourceIconCache(join(dir,'failed'),{sources:{sample:'https://icons.example/sample.png'},request:async()=>{failedCalls++;throw Error('offline');}});
  await failed.get('sample'); await failed.warm('sample'); await failed.get('sample'); assert.equal(failedCalls,1);
});
test('progress is normalized without per-episode viewing history',()=>{
  const item=entry({...sample,progress:99,history:[{at:new Date().toISOString(),progress:2}]});
  assert.equal(item.progress,28);
  assert.equal(Object.hasOwn(item,'history'),false);
});
test('HTTP: full save/reload, conflict, host/origin protection and static-file isolation',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yingjian-http-test-'));
  const server=makeServer({dataDir});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{ server.closeAllConnections?.(); server.closeIdleConnections?.(); server.close(); });
  const base=`http://127.0.0.1:${server.address().port}`, headers={'X-Yingjian':'1','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/library')).status,403);
  assert.equal((await fetch(base+'/api/library',{headers:{...headers,Origin:'https://evil.test'}})).status,403);
  const forgedHost = await new Promise((resolve,reject)=>{const r=httpRequest(base+'/',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
  assert.equal(forgedHost,403);
  for(const path of ['/server.mjs','/.env','/data/library.json','/lib/store.mjs','/%2e%2e/etc/passwd'])assert.equal((await fetch(base+path)).status,404,path);
  const saved=await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({revision:0,entries:[sample]})});assert.equal(saved.status,200);
  assert.equal((await (await fetch(base+'/api/library',{headers})).json()).entries[0].title,sample.title);
  const appInfo=await (await fetch(base+'/api/app-info',{headers})).json(), manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(appInfo.version,manifest.version);assert.ok(['Finder','文件资源管理器','文件管理器'].includes(appInfo.fileManager));assert.equal(appInfo.dataDirectory,dataDir);
  assert.equal((await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({revision:0,entries:[]})})).status,409);
  assert.equal((await fetch(base+'/api/image?url=http://127.0.0.1:80')).status,400);
});
