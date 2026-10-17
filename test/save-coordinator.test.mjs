import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {entry,preferences} from '../src/model.js';
import {createSaveCoordinator,librarySaveFingerprint,resolveLibrarySave} from '../src/library-save.js';
const payload=()=>({requestId:randomUUID(),revision:0,entries:[entry({id:'manual:one',title:'星海巡航',type:'anime',updatedAt:'2026-10-10T00:00:00Z'})],settings:preferences()});
const proof=async value=>({state:'completed',requestId:value.requestId,fingerprint:await librarySaveFingerprint(value),revision:value.revision+1,library:{revision:value.revision+1,entries:value.entries,settings:value.settings}});
test('unconfirmed caller stays pending; retry uses a deep-frozen copy and completes its original continuation',async()=>{
  const original=payload(),sent=[],states=[];let available=false,continued=false;
  const coordinator=createSaveCoordinator({send:async value=>{sent.push(value);if(!available)throw Error('lost');return proof(value);},confirm:async()=>({state:'unknown',requestId:original.requestId}),state:value=>states.push(value)});
  const waiting=coordinator.save(original).then(result=>{continued=true;return result;});await coordinator.retry();assert.equal(coordinator.unconfirmed,true);assert.equal(continued,false);
  original.entries[0].note='后来输入';original.settings.theme='amber';assert.equal(sent[0].entries[0].note,'');assert.equal(sent[0].settings.theme,'blue');assert.equal(Object.isFrozen(sent[0].entries[0]),true);available=true;await coordinator.retry();assert.equal((await waiting).state,'completed');assert.equal(sent[0],sent[1]);assert.equal(coordinator.unconfirmed,false);assert.equal(states.at(-1).unconfirmed,false);
});
test('parallel recovery clicks join one attempt and cannot start another write',async()=>{
  const value=payload();let release;const gate=new Promise(resolve=>release=resolve);let requests=0;const coordinator=createSaveCoordinator({send:async payload=>{requests++;await gate;return proof(payload);},confirm:async()=>{throw Error('unused');}});
  const result=coordinator.save(value),a=coordinator.retry(),b=coordinator.retry();assert.equal(a,b);await assert.rejects(coordinator.save(payload()),/上一项/);release();await Promise.all([a,b]);assert.equal((await result).state,'completed');assert.equal(requests,1);
});
test('known unpublished server failure releases original caller; uncertain transport never does',async()=>{
  const value=payload(),unknown=async()=>({state:'unknown',requestId:value.requestId,currentRevision:0});
  const rejected=await resolveLibrarySave(value,{send:async()=>{throw Object.assign(Error('disk full'),{status:503});},confirm:unknown});assert.equal(rejected.state,'rejected');
  assert.equal((await resolveLibrarySave(value,{send:async()=>{throw Error('disconnected');},confirm:unknown})).state,'pending');
  assert.equal((await resolveLibrarySave(value,{send:async()=>{throw Object.assign(Error('migration'),{status:503,migrationPending:true});},confirm:unknown})).state,'pending');
  assert.equal((await resolveLibrarySave(value,{send:async()=>{throw Object.assign(Error('timeout'),{status:408});},confirm:unknown})).state,'pending');
});
test('receipt confirmation takes precedence over later errors and returns the latest archive',async()=>{
  const value=payload(),completed=await proof(value);completed.library={revision:2,entries:[],settings:preferences({theme:'amber'})};
  const coordinator=createSaveCoordinator({send:async()=>{throw Object.assign(Error('conflict'),{status:409});},confirm:async()=>completed});const outcome=await coordinator.save(value);assert.equal(outcome.state,'completed');assert.deepEqual(outcome.result.library.entries,[]);assert.equal(outcome.result.library.settings.theme,'amber');
});
