import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DataDirectoryLease, DATA_LEASE_FILE } from '../lib/data-lease.mjs';
import { makeServer } from '../server.mjs';

const temporary = prefix => mkdtemp(join(tmpdir(), prefix));

test('data directory lease blocks a second owner and releases cleanly', async () => {
  const dir = await temporary('fandu-lease-');
  const first = new DataDirectoryLease(dir), second = new DataDirectoryLease(dir);
  await first.acquire();
  await assert.rejects(second.acquire(), error => error.code === 'FANDU_DATA_IN_USE' && /已在使用/.test(error.message));
  await first.release();
  await second.acquire();
  await second.release();
});

test('data directory lease replaces a crashed owner but not a live owner', async () => {
  const dir = await temporary('fandu-stale-lease-');
  const path = join(dir, DATA_LEASE_FILE);
  await writeFile(path, JSON.stringify({ app:'fandu', pid:9_999_999, token:'stale', startedAt:'2020-01-01T00:00:00.000Z' }));
  const lease = new DataDirectoryLease(dir);
  await lease.acquire();
  const owner = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, 'stale');
  await lease.release();
});

test('servers sharing one archive cannot listen concurrently and can reopen after close', async t => {
  const dir = await temporary('fandu-server-lease-');
  const first = makeServer({ dataDir:dir });
  first.listen(0, '127.0.0.1');
  await once(first, 'listening');
  t.after(() => { first.closeAllConnections?.(); if (first.listening) first.close(); });

  const second = makeServer({ dataDir:dir });
  const refused = new Promise(resolve => second.once('error', resolve));
  second.listen(0, '127.0.0.1');
  const error = await refused;
  assert.equal(error.code, 'FANDU_DATA_IN_USE');

  await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));
  const reopened = makeServer({ dataDir:dir });
  reopened.listen(0, '127.0.0.1');
  await once(reopened, 'listening');
  await new Promise((resolve, reject) => reopened.close(error => error ? reject(error) : resolve()));
});

test('server startup removes only known atomic-write leftovers after taking the lease', async () => {
  const dir = await temporary('fandu-maintenance-');
  const covers = join(dir, 'covers'), icons = join(dir, 'source-icons');
  await Promise.all([mkdir(covers), mkdir(icons)]);
  const archiveTemp = `library.json.${randomUUID()}.tmp`;
  const migrationTemp=`migration-pending.json.${randomUUID()}.tmp`;
  const receiptTemp=`migration-receipts.json.${randomUUID()}.tmp`;
  const draftTemp=`entry-drafts.json.${randomUUID()}.tmp`;
  const coverTemp = 'index.json.tmp-999-deadbeef';
  const iconTemp = '.index-999-1700000000000-abc123.tmp';
  await Promise.all([
    writeFile(join(dir, archiveTemp), 'partial'),
    writeFile(join(dir,migrationTemp),'partial'),
    writeFile(join(dir,receiptTemp),'partial'),
    writeFile(join(dir,draftTemp),'partial'),
    writeFile(join(dir,'entry-drafts.json'),'keep'),
    writeFile(join(dir,'entry-drafts.json.user.tmp'),'keep'),
    writeFile(join(dir,'migration-pending.json'),'keep'),
    writeFile(join(dir,'migration-pending.json.user.tmp'),'keep'),
    writeFile(join(covers, coverTemp), 'partial'),
    writeFile(join(icons, iconTemp), 'partial'),
    writeFile(join(dir, 'notes.tmp'), 'keep'),
    writeFile(join(covers, 'user-image.tmp-999-deadbeef'), 'keep')
  ]);

  const server = makeServer({ dataDir:dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  assert.equal((await readdir(dir)).includes(archiveTemp), false);
  assert.equal((await readdir(dir)).includes(migrationTemp),false);
  assert.equal((await readdir(dir)).includes(receiptTemp),false);
  assert.equal((await readdir(dir)).includes(draftTemp),false);
  assert.equal(await readFile(join(dir,'entry-drafts.json'),'utf8'),'keep');
  assert.equal((await readdir(dir)).includes('entry-drafts.json.user.tmp'),true);
  assert.equal(await readFile(join(dir,'migration-pending.json'),'utf8'),'keep','即使记录损坏也不能把已发布迁移意图当成临时文件删除');
  assert.equal((await readdir(dir)).includes('migration-pending.json.user.tmp'),true);
  assert.equal((await readdir(covers)).includes(coverTemp), false);
  assert.equal((await readdir(icons)).includes(iconTemp), false);
  assert.equal((await readdir(dir)).includes('notes.tmp'), true);
  assert.equal((await readdir(covers)).includes('user-image.tmp-999-deadbeef'), true);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
