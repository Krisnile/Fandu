import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { Images } from '../lib/sources.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const url = n => `https://lain.bgm.tv/pic/cover/m/queue-${n}.png`;
const response = () => new Response(png);

test('images: a 32-cover canvas queues in FIFO order, deduplicates, and never exceeds 8 upstream requests', async () => {
  const started = [], gates = [];
  let active = 0, peak = 0;
  const images = new Images({ request: async (address, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    started.push(address); peak = Math.max(peak, ++active);
    await new Promise(resolve => gates.push(resolve));
    active--; return response();
  } });
  const jobs = Array.from({ length: 32 }, (_, n) => images.load(url(n)));
  const duplicate = images.load(url(20));
  await tick();
  assert.equal(started.length, 8); assert.equal(images.queue.length, 24);
  // Drain one wave at a time; newly released slots must go to the oldest waiter.
  for (let wave = 0; wave < 4; wave++) {
    gates.splice(0).forEach(resolve => resolve());
    await tick();
  }
  const results = await Promise.all(jobs);
  assert.equal(await duplicate, results[20]);
  assert.deepEqual(started, Array.from({ length: 32 }, (_, n) => url(n)));
  assert.equal(peak, 8); assert.equal(images.active, 0);
  assert.equal(images.queue.length, 0); assert.equal(images.pending.size, 0);
  assert.equal(await images.load(url(0)), results[0]); assert.equal(started.length, 32);
});

test('images: bounded queue rejects overflow, expires waiters, and permits a later retry', async () => {
  let finish;
  const started = [];
  const images = new Images({ concurrency: 1, maxQueued: 1, queueTimeout: 20, request: async address => {
    started.push(address);
    if (address === url(0)) await new Promise(resolve => { finish = resolve; });
    return response();
  } });
  const first = images.load(url(0));
  const timedOut = assert.rejects(images.load(url(1)), /等待超时/);
  await assert.rejects(images.load(url(2)), /队列已满/);
  await timedOut;
  assert.equal(images.queue.length, 0); assert.equal(images.pending.size, 1);
  assert.deepEqual(started, [url(0)]);
  finish(); await first;
  assert.equal((await images.load(url(1))).type, 'image/png');
  assert.equal(images.active, 0); assert.equal(images.pending.size, 0);
});

test('images: upstream errors and invalid images release slots; stale cache survives a failed refresh', async () => {
  const images = new Images({ concurrency: 1, request: async address => {
    if (address === url(0)) throw Error('offline');
    if (address === url(1)) return new Response('<svg></svg>');
    if (address === url(2)) return new Response('bad gateway', { status: 502 });
    if (address === url(3)) return new Response(png, { headers: { 'Content-Length': String(3 * 1024 * 1024) } });
    return response();
  } });
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => images.load(url(n))));
  assert.deepEqual(outcomes.map(x => x.status), ['rejected','rejected','rejected','rejected','fulfilled']);
  assert.equal(images.active, 0); assert.equal(images.queue.length, 0); assert.equal(images.pending.size, 0);
  const cached = outcomes[4].value; cached.time -= 3600_001;
  images.request = async () => { throw Error('offline'); };
  assert.equal(await images.load(url(4)), cached);
  await assert.rejects(images.load('http://127.0.0.1/private'), /不支持/);
  assert.equal(images.active, 0);
});

test('images: custom covers use the same queue and format limits without bypassing the public-URL resolver', async () => {
  let calls = 0;
  const images = new Images({ concurrency: 1, request: async () => { throw Error('wrong transport'); }, customRequest: async address => {
    calls++; assert.equal(address, 'https://covers.example.com/custom.png'); return png;
  } });
  const a = images.load('https://covers.example.com/custom.png', true);
  const b = images.load('https://covers.example.com/custom.png', true);
  assert.equal(await a, await b); assert.equal(calls, 1); assert.equal(images.active, 0);
  // The production transport must still reject private destinations before connecting.
  const real = new Images();
  await assert.rejects(real.load('https://127.0.0.1/private.png', true));
  assert.equal(real.active, 0); assert.equal(real.pending.size, 0);
});
