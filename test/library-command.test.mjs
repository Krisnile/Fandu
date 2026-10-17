import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryCommand,applyLibraryCommand} from '../src/library-command.js';
import {entry,preferences,MAX_LISTS,MAX_SERIES,MAX_MANAGED_TAGS} from '../src/model.js';
const fixture=()=>({revision:7,entries:[entry({id:'manual:one',title:'星海巡航',type:'anime',status:'watching',total:14,progress:9,note:'后来修改的笔记',rating:4,tags:['旧标签'],lists:['list-one'],seriesId:'series-one'})],settings:preferences({lists:[...preferences().lists,{id:'list-one',label:'周末',kind:'custom'},{id:'list-two',label:'假日',kind:'custom'}],series:[{id:'series-one',label:'星海系列'}],tags:['旧标签']})});
test('batch actions use current targets, preserve other fields and never recreate missing works',()=>{
  const library=fixture(),before=structuredClone(library),result=applyLibraryCommand(library,{type:'batch-list',listId:'completed',ids:['manual:one','manual:deleted']});
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].progress,14);assert.equal(result.entries[0].status,'completed');assert.equal(result.entries[0].note,library.entries[0].note);assert.equal(result.entries[0].rating,4);assert.deepEqual(library,before);
  const custom=applyLibraryCommand(library,{type:'batch-list',listId:'list-two',ids:['manual:one']});assert.deepEqual(custom.entries[0].lists,['list-one','list-two']);
  assert.throws(()=>applyLibraryCommand(library,{type:'batch-list',listId:'library',ids:['manual:one']}));assert.throws(()=>applyLibraryCommand(library,{type:'batch-list',listId:'list-two',ids:['manual:gone']}));
});
test('create commands have fixed identities, normalized duplicate protection and capacity limits',()=>{
  const library=fixture();for(const [type,field,id,label,max] of [['create-list','lists','list-new','新列表',MAX_LISTS],['create-series','series','series-new','新系列',MAX_SERIES],['create-tag','tags',undefined,'新标签',MAX_MANAGED_TAGS]]){
    const command={type,...(id?{id}:{}),label},result=applyLibraryCommand(library,command);assert.equal(result.settings[field].at(-1)?.id||result.settings[field].at(-1),id||label);
    assert.throws(()=>applyLibraryCommand({...library,settings:result.settings},command));
    const full={...library,settings:preferences({...library.settings,[field]:field==='tags'?Array.from({length:max},(_,i)=>`标签${i}`):Array.from({length:max},(_,i)=>({id:`item-${i}`,label:`名称${i}`,...(field==='lists'?{kind:i?'custom':'all'}:{})}))})};assert.throws(()=>applyLibraryCommand(full,command));
  }
  assert.throws(()=>libraryCommand({type:'create-list',id:'a'.repeat(61),label:'新列表'}));assert.throws(()=>libraryCommand({type:'create-series',id:'series-new',label:' Ａ '}));
});
test('deletion requires the confirmed name and removes only the relevant memberships',()=>{
  const library=fixture(),list=applyLibraryCommand(library,{type:'delete-list',id:'list-one',expectedLabel:'周末'});assert.deepEqual(list.entries[0].lists,[]);assert.equal(list.entries[0].seriesId,'series-one');assert.equal(list.entries[0].note,library.entries[0].note);
  assert.throws(()=>applyLibraryCommand(library,{type:'delete-list',id:'list-one',expectedLabel:'旧名称'}));assert.throws(()=>applyLibraryCommand(library,{type:'delete-list',id:'library',expectedLabel:'收藏'}));
  const series=applyLibraryCommand(library,{type:'delete-series',id:'series-one',expectedLabel:'星海系列'});assert.equal(series.entries[0].seriesId,'');assert.deepEqual(series.entries[0].lists,['list-one']);
  const tags=applyLibraryCommand(library,{type:'delete-tag',label:'旧标签'});assert.deepEqual(tags.entries[0].tags,[]);assert.deepEqual(tags.settings.tags,[]);
  const imported={...library,settings:preferences({...library.settings,tags:['Ａ']} )};assert.equal(applyLibraryCommand(imported,{type:'delete-tag',label:'A'}).settings.tags.includes('A'),false);
});
test('relative progress, restart and guarded undo preserve later independent edits',()=>{
  const library=fixture(),increment=applyLibraryCommand(library,{type:'increment-progress',id:'manual:one'});assert.equal(increment.entries[0].progress,10);
  const restarted=applyLibraryCommand(library,{type:'restart-entry',id:'manual:one'});assert.equal(restarted.entries[0].progress,0);assert.equal(restarted.effects.previous.progress,9);
  const current={...library,entries:[{...restarted.entries[0],note:'重看后的笔记',rating:5}]},undo=applyLibraryCommand(current,{type:'undo-restart',id:'manual:one',previous:{status:'watching',progress:9,note:'不得覆盖'}});assert.equal(undo.entries[0].progress,9);assert.equal(undo.entries[0].note,'重看后的笔记');assert.equal(undo.entries[0].rating,5);
  assert.throws(()=>applyLibraryCommand(library,{type:'undo-restart',id:'manual:one',previous:{status:'watching',progress:9}}));
  assert.throws(()=>applyLibraryCommand({...library,entries:[{...library.entries[0],status:'completed'}]},{type:'increment-progress',id:'manual:one'}));
});
test('remove/restore never overwrite re-added records or recreate deleted containers',()=>{
  const library=fixture(),removed=applyLibraryCommand(library,{type:'remove-entry',id:'manual:one'});assert.deepEqual(removed.entries,[]);assert.equal(removed.effects.removed.note,library.entries[0].note);
  const restored=applyLibraryCommand({...removed,settings:preferences()},{type:'restore-entry',entry:removed.effects.removed});assert.deepEqual(restored.entries[0].lists,[]);assert.equal(restored.entries[0].seriesId,'');
  assert.throws(()=>applyLibraryCommand(library,{type:'restore-entry',entry:removed.effects.removed}));assert.throws(()=>applyLibraryCommand({...library,entries:[]},{type:'remove-entry',id:'manual:one'}));
});
test('reorder follows current neighbours and cannot move the collection root',()=>{
  const library=fixture(),moved=applyLibraryCommand(library,{type:'move-list',id:'list-two',targetId:'list-one',before:true});assert.equal(moved.settings.lists[0].id,'library');assert.equal(moved.settings.lists.findIndex(item=>item.id==='list-two')+1,moved.settings.lists.findIndex(item=>item.id==='list-one'));
  assert.throws(()=>applyLibraryCommand(library,{type:'move-list',id:'list-two',targetId:'library',before:true}));assert.throws(()=>libraryCommand({type:'erase-all'}));
});
