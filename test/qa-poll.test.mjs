import test from 'node:test';
import assert from 'node:assert/strict';
import { pollAsync, waitForAsync } from '../scripts/qa-poll.mjs';

test('QA asynchronous checks poll resolved false values until the condition is true', async () => {
  let attempts=0;
  const page={evaluate:async (predicate,arg)=>predicate(arg)};
  await waitForAsync(page,async expected=>++attempts===expected,3,{interval:1});
  assert.equal(attempts,3);
});

test('QA asynchronous checks do not pass a false Promise at the deadline', async () => {
  let attempts=0;
  await assert.rejects(pollAsync(async()=>{attempts++;return false;},{timeout:0,description:'persisted archive'}),/persisted archive after 1 checks/);
  assert.equal(attempts,1);
});

test('QA asynchronous checks surface evaluation failures rather than reporting success', async () => {
  await assert.rejects(pollAsync(async()=>{throw Error('invalid archive response');}),/invalid archive response/);
});
