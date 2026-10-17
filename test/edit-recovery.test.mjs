import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recoveryRecord,applyRecoveredFields,EDIT_RECOVERY_LIMITS} from '../src/edit-recovery.js';
import {entry,preferences} from '../src/model.js';
import {createSaveCoordinator,librarySaveFingerprint} from '../src/library-save.js';
const draft=()=>({format:1,id:randomUUID(),version:randomUUID(),updatedAt:new Date().toISOString(),kind:'note',target:'manual:one',label:'星海巡航',value:{value:'未完成的笔记'}});
test('recovery drafts preserve raw input without allowing invalid kinds, keys or oversized data',()=>{
  const value=draft();assert.deepEqual(recoveryRecord(value),value);for(const broken of [{...value,format:2},{...value,id:[value.id]},{...value,key:'intent:'+value.id},{...value,kind:'script'},{...value,value:{value:7}},{...value,value:{value:'字'.repeat(4001)}}])assert.throws(()=>recoveryRecord(broken));
  assert.equal(EDIT_RECOVERY_LIMITS.drafts,64);assert.throws(()=>recoveryRecord({...value,kind:'settings',value:{lists:[]}}));
  const form={...value,kind:'form',value:{id:value.target,values:{title:''},lists:[],changedFields:['title']}};assert.equal(recoveryRecord(form).value.values.title,'');assert.throws(()=>recoveryRecord({...form,value:{...form.value,changedFields:['id']}}));
  assert.throws(()=>recoveryRecord({...value,kind:'fields',value:{patch:{rating:'5'}}}));assert.throws(()=>recoveryRecord({...value,kind:'fields',value:{patch:{status:'deleted'}}}));
});
test('fixed intents keep exact identity, dates and content while rejecting foreign indexes',async()=>{
  const id=randomUUID(),payload={requestId:id,revision:0,entries:[entry({id:'manual:one',title:'星海巡航',type:'anime'})],settings:preferences()},value={format:1,id,kind:'intent',updatedAt:new Date().toISOString(),payload,fingerprint:await librarySaveFingerprint(payload)};
  assert.deepEqual(recoveryRecord(value).payload,payload);assert.throws(()=>recoveryRecord({...value,id:randomUUID()}));assert.throws(()=>recoveryRecord({...value,key:'draft:'+id}));
});
test('recovering progress or completed status respects newer totals and preserves independent fields',()=>{
  const latest=entry({id:'manual:one',title:'星海巡航',type:'anime',total:14,progress:10,status:'watching',note:'后来修改的笔记',rating:4});
  const progress=applyRecoveredFields(latest,{patch:{progress:12,status:'completed'},action:'progress'});assert.equal(progress.progress,12);assert.equal(progress.status,'watching');assert.equal(progress.note,latest.note);assert.equal(progress.rating,4);
  const completed=applyRecoveredFields(latest,{patch:{progress:12,status:'completed'},action:'status'});assert.equal(completed.progress,14);assert.equal(completed.status,'completed');assert.equal(completed.note,latest.note);
});
test('failed recovery preparation never sends; retry prepares the same intent before transmission',async()=>{
  const payload={requestId:randomUUID(),revision:0,entries:[entry({id:'manual:one',title:'星海巡航',type:'anime'})],settings:preferences()};let available=false,sends=0,prepares=0,finished=0;
  const coordinator=createSaveCoordinator({prepare:async()=>{prepares++;if(!available)throw Error('quota');},finish:async()=>{finished++;},send:async value=>{sends++;return {state:'completed',requestId:value.requestId,fingerprint:await librarySaveFingerprint(value),revision:1,library:{revision:1,entries:value.entries,settings:value.settings}};},confirm:async()=>{throw Error('unused');}});
  const waiting=coordinator.save(payload);await coordinator.retry();assert.equal(coordinator.unconfirmed,true);assert.equal(sends,0);available=true;await coordinator.retry();assert.equal((await waiting).state,'completed');assert.equal(sends,1);assert.equal(prepares,2);assert.equal(finished,1);
});
test('cleanup failure retains the fixed intent and never releases a misleading success continuation',async()=>{
  const payload={requestId:randomUUID(),revision:0,entries:[entry({id:'manual:one',title:'星海巡航',type:'anime'})],settings:preferences()},sent=[];let clean=false;
  const coordinator=createSaveCoordinator({send:async value=>{sent.push(value);return {state:'completed',requestId:value.requestId,fingerprint:await librarySaveFingerprint(value),revision:1,library:{revision:1,entries:value.entries,settings:value.settings}};},confirm:async()=>{throw Error('unused');},finish:async()=>{if(!clean)throw Error('cleanup unavailable');}});
  const waiting=coordinator.save(payload);await coordinator.retry();assert.equal(coordinator.unconfirmed,true);clean=true;await coordinator.retry();assert.equal((await waiting).state,'completed');assert.equal(sent[0],sent[1]);
});
