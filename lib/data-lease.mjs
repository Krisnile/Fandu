import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const LOCK_NAME = '.fandu-instance';
const PENDING_LOCK_MS = 5_000;
const RETRIES = 8;
const RETRY_MS = 60;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH' || error?.code === 'EINVAL') return false;
    // EPERM/EACCES means the process exists but this account cannot signal it.
    return true;
  }
}

function inUseError() {
  const error = Error('番渡已在使用这个数据目录。请切换到已打开的番渡，或关闭另一个实例后重试。');
  error.code = 'FANDU_DATA_IN_USE';
  return error;
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ownerState(path) {
  try {
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    let owner = null;
    try { owner = JSON.parse(raw); } catch { /* A fresh owner may still be writing. */ }
    if (owner && Number.isSafeInteger(owner.pid) && typeof owner.token === 'string') {
      return { active: processIsAlive(owner.pid), pending: false };
    }
    return { active: false, pending: Date.now() - info.mtimeMs < PENDING_LOCK_MS };
  } catch (error) {
    if (error?.code === 'ENOENT') return { active: false, pending: false };
    throw error;
  }
}

export class DataDirectoryLease {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, LOCK_NAME);
    this.handle = null;
    this.token = '';
  }

  async acquire() {
    if (this.handle) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      let handle;
      try {
        handle = await open(this.path, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const owner = await ownerState(this.path);
        if (owner.active) throw inUseError();
        if (owner.pending) { await wait(RETRY_MS); continue; }
        await unlink(this.path).catch(unlinkError => {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }

      const token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ app: 'fandu', pid: process.pid, token, startedAt: new Date().toISOString() }));
        await handle.sync();
        await syncDirectory(this.dataDir);
        this.handle = handle;
        this.token = token;
        return;
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(this.path).catch(() => {});
        throw error;
      }
    }
    throw inUseError();
  }

  async release() {
    const handle = this.handle, token = this.token;
    this.handle = null;
    this.token = '';
    await handle?.close().catch(() => {});
    if (!token) return;
    try {
      const owner = JSON.parse(await readFile(this.path, 'utf8'));
      if (owner?.token !== token) return;
      await unlink(this.path);
      await syncDirectory(this.dataDir);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
}

export const DATA_LEASE_FILE = LOCK_NAME;
