import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../src/autosave.js';

test('autosave keeps edits made during an in-flight request and serializes writes', async () => {
  let release, active = 0, peak = 0;
  const writes = [], gate = new Promise(resolve => { release = resolve; });
  const save = createAutosave({ delay:60000, write:async patch => {
    peak = Math.max(peak,++active); writes.push(patch);
    if (writes.length === 1) await gate;
    active--;
  }});
  save.schedule({theme:'blue'}); const first = save.flush();
  save.schedule({theme:'violet',accent:'#123456'});
  save.schedule({theme:'cyan'}); release(); await first;
  assert.deepEqual(writes,[{theme:'blue'},{theme:'cyan',accent:'#123456'}]);
  assert.equal(peak,1); assert.equal(save.dirty,false);
});

test('autosave retains failed data for retry and newer values win', async () => {
  let fail = true; const writes = [], states = [];
  const save = createAutosave({delay:60000,state:s=>states.push(s),write:async patch=>{
    if(fail)throw Error('disk unavailable'); writes.push(patch);
  }});
  save.schedule({theme:'violet',view:'list'});
  assert.equal(await save.flush(),false); assert.equal(save.dirty,true);
  save.schedule({theme:'cyan'}); fail=false;
  assert.equal(await save.flush(),true);
  assert.deepEqual(writes,[{theme:'cyan',view:'list'}]);
  assert.ok(states.includes('error')); assert.equal(states.at(-1),'saved');
});
test('explicit discard cancels queued edits but waits for an already-started write',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),writes=[];
  const save=createAutosave({delay:60000,write:async patch=>{writes.push(patch);await gate;}});
  save.schedule({note:'first'});const write=save.flush();save.schedule({note:'discarded'});const canceled=save.cancel();release();await Promise.all([write,canceled]);assert.deepEqual(writes,[{note:'first'}]);assert.equal(save.dirty,false);assert.equal(await save.flush(),true);
});
