import test from 'node:test';
import assert from 'node:assert/strict';
import { entry, preferences } from '../src/model.js';
import { sortEntries, summarizeEntries, timelineGroups, premiereYear, premiereDetail } from '../src/insights.js';
test('insights count real records and exclude unrated entries from average',()=>{
  const items=[entry({id:'a',title:'A',type:'anime',rating:4,status:'completed',year:2024}),entry({id:'b',title:'B',type:'movie',rating:0,year:2026})];
  assert.deepEqual(summarizeEntries(items),{total:2,completed:1,rated:1,average:4,types:{anime:1,movie:1,tv:0},statuses:{watching:0,planned:1,completed:1,paused:0}});
  assert.equal(summarizeEntries([]).average,null);
  assert.equal(sortEntries(items,'year')[0].id,'b');assert.equal(items[0].id,'a');
  const importedLate = entry({id:'imported-late',title:'Imported late',type:'anime',year:2024,airedAt:'2024-01-01T00:00:00Z',createdAt:'2026-09-01',updatedAt:'2026-09-01'});
  const premieredLate = entry({id:'premiered-late',title:'Premiered late',type:'anime',year:2026,airedAt:'2026-01-01T00:00:00Z',createdAt:'2024-01-01',updatedAt:'2024-01-01'});
  assert.equal(sortEntries([importedLate,premieredLate],'premiere')[0].id,'premiered-late');
  assert.equal(sortEntries([importedLate,premieredLate],'created')[0].id,'premiered-late');
  assert.equal(sortEntries([importedLate,premieredLate],'updated')[0].id,'premiered-late');
  assert.equal(preferences({sort:'score'}).sort,'score');assert.equal(preferences({sort:'bad'}).sort,'premiere');
  assert.equal(preferences({sort:'created'}).sort,'premiere');assert.equal(preferences({sort:'updated'}).sort,'premiere');
  assert.equal(preferences({timeline:'createdAt'}).timeline,'premiere');assert.equal(preferences({timeline:'bad'}).timeline,'premiere');
});
test('timeline does not invent a collection date for legacy records',()=>{
  const old=entry({id:'old',title:'Old',type:'anime',updatedAt:'2025-04-01'});
  const recent=entry({id:'new',title:'New',type:'anime',createdAt:'2026-08-01',updatedAt:'2026-09-01'});
  assert.equal(old.createdAt,null);
  const groups=timelineGroups([old,recent],'createdAt');
  assert.equal(groups[0][1][0].id,'new');assert.equal(groups[1][0],'日期未知');
  const premiereDefault = timelineGroups([old,recent]);
  assert.equal(premiereDefault[0][0],'日期未知');
  assert.deepEqual(premiereDefault[0][1].map(x=>x.id),['new','old']);
});
test('timeline uses premiere metadata for imported works and keeps unknown dates explicit',()=>{
  const season=entry({id:'season',title:'Season',type:'anime',year:2024,season:'秋',createdAt:'2026-09-01',updatedAt:'2026-09-01'});
  const exact=entry({id:'exact',title:'Exact',type:'anime',airedAt:'2025-05-20T00:00:00Z',createdAt:'2026-09-01',updatedAt:'2026-09-01'});
  const unknown=entry({id:'unknown',title:'Unknown',type:'anime',createdAt:'2026-09-01',updatedAt:'2026-09-01'});
  const groups=timelineGroups([season,unknown,exact],'premiere');
  assert.equal(groups[0][0],'2025年5月20日'); assert.equal(groups[0][1][0].id,'exact');
  assert.equal(groups[1][0],'2024年秋季'); assert.equal(groups[1][1][0].id,'season');
  assert.equal(groups[2][0],'日期未知'); assert.equal(groups[2][1][0].id,'unknown');
  assert.equal(premiereYear(exact),2025);assert.equal(premiereYear(season),2024);assert.equal(premiereYear(unknown),null);
  assert.equal(premiereDetail(exact),'5月20日');assert.equal(premiereDetail(season),'秋季');assert.equal(premiereDetail(unknown),'日期未知');
});
test('schedule metadata is bounded and rejects invalid times',()=>{
  const item=entry({id:'a',title:'A',type:'anime',studios:['Studio','Studio'],broadcastDay:9,broadcastTime:'99:00',airedAt:'invalid'});
  assert.deepEqual(item.studios,['Studio']);assert.equal(item.broadcastDay,null);assert.equal(item.broadcastTime,'');assert.equal(item.airedAt,null);
});
