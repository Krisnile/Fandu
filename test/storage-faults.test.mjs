import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {LibraryStore} from '../lib/store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'yingjian-storage-fault-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const store = new LibraryStore(dir);
  await store.save({revision:0, entries:[{id:'fault-test', title:'故障测试', type:'anime', note:'first'}], settings:{theme:'cyan'}});
  await store.save({revision:1, entries:[{id:'fault-test', title:'故障测试', type:'anime', note:'second'}], settings:{theme:'amber'}});
  return {dir, store, before:await readFile(join(dir, 'library.json'))};
}
function runFault(dir, operation, fault) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [fileURLToPath(new URL('../scripts/storage-fault-worker.mjs', import.meta.url)), dir, operation, fault], {stdio:['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    worker.stdout.on('data', x => stdout += x);
    worker.stderr.on('data', x => stderr += x);
    const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(Error('Fault worker timed out')); }, 10000);
    worker.on('error', e => {clearTimeout(timer); reject(e);});
    worker.on('close', (code, signal) => {clearTimeout(timer); resolve({code, signal, stdout, stderr});});
  });
}

for (const operation of ['save', 'restore']) {
  for (const [fault, code] of [['write','ENOSPC'], ['sync','EIO'], ['rename','EACCES']]) {
    test(`storage ${operation}: ${code} preserves main bytes and permits retry`, async t => {
      const {dir, before} = await fixture(t);
      const result = await runFault(dir, operation, fault);
      assert.equal(result.code, 71, result.stderr);
      assert.equal(result.stdout, code);
      assert.deepEqual(await readFile(join(dir, 'library.json')), before);
      const names = await readdir(dir);
      assert.equal(names.some(x => x.endsWith('.tmp')), false);
      const store = new LibraryStore(dir);
      assert.equal((await store.read()).entries[0].note, 'second');
      if (operation === 'restore') {
        const copies = names.filter(x => x.startsWith('recovery-'));
        assert.equal(copies.length, 1);
        assert.deepEqual(await readFile(join(dir, copies[0])), before);
      }
      const current = await store.read();
      assert.equal((await store.save({...current, entries:current.entries.map(x => ({...x, note:'retry'}))})).entries[0].note, 'retry');
    });
  }
  for (const fault of ['crash-before', 'crash-after']) {
    test(`storage ${operation}: ${fault} leaves a complete readable archive after restart`, async t => {
      const {dir, before} = await fixture(t);
      const result = await runFault(dir, operation, fault);
      assert.equal(result.signal, 'SIGKILL', result.stderr);
      const store = new LibraryStore(dir), current = await store.read();
      const expected = fault === 'crash-before' ? 'second' : operation === 'save' ? 'new draft' : 'first';
      assert.equal(current.entries[0].note, expected);
      if (fault === 'crash-before') assert.deepEqual(await readFile(join(dir, 'library.json')), before);
      if (operation === 'restore') {
        const copies = (await readdir(dir)).filter(x => x.startsWith('recovery-'));
        assert.equal(copies.length, 1);
        assert.deepEqual(await readFile(join(dir, copies[0])), before);
      }
      assert.equal((await store.save({...current, entries:[]})).entries.length, 0);
      await assert.rejects(store.save({...current, entries:[]}), e => e.status === 409);
    });
  }
}

test('storage rejects oversized archives and revision overflow before changing files', async t => {
  const {dir, store} = await fixture(t);
  const path = join(dir, 'library.json');
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, ' ');
  await writeFile(path, oversized);
  await assert.rejects(store.read(), /无法读取/);
  await assert.rejects(store.save({revision:2, entries:[]}), /无法读取/);
  assert.deepEqual(await readFile(path), oversized);
  const exhausted = JSON.stringify({revision:Number.MAX_SAFE_INTEGER, entries:[]});
  await writeFile(path, exhausted);
  const names = await readdir(dir);
  await assert.rejects(store.save({revision:Number.MAX_SAFE_INTEGER, entries:[]}), /版本超出范围/);
  assert.equal(await readFile(path, 'utf8'), exhausted);
  assert.deepEqual(await readdir(dir), names);
});
