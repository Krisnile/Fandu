import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {syncDirectory} from './store.mjs';

const INDEX_VERSION = 1;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 120;
const MAX_BUNDLE_ITEMS = 1200;
const MAX_BUNDLE_BYTES = 48 * 1024 * 1024;
const typeExt = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' };
const cacheFile = /^[a-f0-9]{64}\.(?:jpg|png|webp)$/;
const keyId = key => createHash('sha256').update(String(key)).digest('hex');
const checksum = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

async function atomicBytes(path, body) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
async function atomicJson(path, value) { await atomicBytes(path, Buffer.from(JSON.stringify(value))); }

// Validate the entire package before a migration writes its durable intent.
// The ordinary cache import uses the very same decoder, never a weaker path.
export function decodeCoverBundle(bundle) {
  const raw=typeof bundle==='string'?JSON.parse(bundle):bundle;
  if(!raw || !['fandu-cover-cache','yingjian-cover-cache'].includes(raw.app) || raw.version!==1 || typeof raw.checksum!=='string' || !Array.isArray(raw.entries) || raw.entries.length>MAX_BUNDLE_ITEMS)throw Error('不是受支持的番渡封面缓存包');
  const {checksum:received,...payload}=raw;
  if(received!==checksum(payload))throw Error('封面缓存包校验失败，文件可能不完整');
  const entries=[],seen=new Set();
  for(const item of raw.entries){
    if(!/^[a-f0-9]{64}$/.test(item?.key) || !typeExt[item?.type] || !Number.isSafeInteger(item?.bytes) || item.bytes<1 || item.bytes>MAX_ITEM_BYTES || typeof item.body!=='string' || seen.has(item.key))throw Error('封面缓存包包含无效图片');
    const body=Buffer.from(item.body,'base64');
    if(!body.length || body.length!==item.bytes || body.length>MAX_ITEM_BYTES || body.toString('base64')!==item.body)throw Error('封面缓存包包含损坏图片');
    entries.push({key:item.key,type:item.type,bytes:body.length,at:Number.isFinite(item.fetchedAt)?item.fetchedAt:Date.now(),body});seen.add(item.key);
  }
  if(Buffer.byteLength(JSON.stringify(raw))>MAX_BUNDLE_BYTES)throw Error('封面缓存包过大');
  return entries;
}

export class CoverCache {
  constructor(dir, { maxItems = MAX_ITEMS, maxBytes = MAX_TOTAL_BYTES } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS || !Number.isInteger(maxBytes) || maxBytes < MAX_ITEM_BYTES || maxBytes > MAX_TOTAL_BYTES) throw Error('封面缓存配置无效');
    this.dir = dir; this.indexPath = join(dir, 'index.json'); this.maxItems = maxItems; this.maxBytes = maxBytes;
    this.index = new Map(); this.bytes = 0; this.tail = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    await mkdir(this.dir, { recursive:true, mode:0o700 });
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (raw.version !== INDEX_VERSION || !Array.isArray(raw.items)) throw Error('invalid cache index');
      for (const item of raw.items) {
        if (!/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(item.file) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_ITEM_BYTES || !typeExt[item.type] || !Number.isFinite(item.at)) continue;
        this.index.set(item.key, item);
        this.bytes += item.bytes;
      }
      const before = this.index.size;
      await this.prune(false);
      if (this.index.size !== before) await this.saveIndex();
    } catch { this.index.clear(); this.bytes = 0; }
  }
  async saveIndex() {
    await atomicJson(this.indexPath, { version:INDEX_VERSION, items:[...this.index.values()] });
  }
  async prune(save = true) {
    const ordered = [...this.index.entries()].sort((a,b) => a[1].at - b[1].at);
    const remove = [];
    while (this.index.size > this.maxItems || this.bytes > this.maxBytes) {
      const [key,item] = ordered.shift();
      if (!item) break;
      this.index.delete(key); this.bytes -= item.bytes; remove.push(item.file);
    }
    await Promise.all(remove.map(file => unlink(join(this.dir,file)).catch(() => {})));
    if (save && remove.length) await this.saveIndex();
  }
  async get(key) {
    await this.ready;
    const id = keyId(key), item = this.index.get(id);
    if (!item) return null;
    try {
      const body = await readFile(join(this.dir,item.file));
      if (body.length !== item.bytes || body.length > MAX_ITEM_BYTES) throw Error('封面缓存大小无效');
      // `at` is the fetch time, not the last read time: stale entries must still
      // reach the network once, then serve as an offline fallback on failure.
      return { body, type:item.type, time:item.at };
    } catch {
      this.index.delete(id); this.bytes -= item.bytes;
      this.enqueue(async () => this.saveIndex());
      return null;
    }
  }
  async set(key, value) {
    await this.ready;
    if (!value?.body || !typeExt[value.type] || value.body.length < 1 || value.body.length > MAX_ITEM_BYTES) return;
    const id = keyId(key), file = `${id}.${typeExt[value.type]}`, item = { key:id, file, type:value.type, bytes:value.body.length, at:Date.now() };
    return this.enqueue(async () => {
      const previous = this.index.get(id);
      if (previous) this.bytes -= previous.bytes;
      await atomicBytes(join(this.dir,file), value.body);
      if (previous && previous.file !== file) await unlink(join(this.dir,previous.file)).catch(() => {});
      this.index.set(id,item); this.bytes += item.bytes;
      await this.prune(false); await this.saveIndex();
    });
  }
  async pruneUnreferenced(keys = []) {
    await this.ready;
    const keep = new Set([...keys].filter(key => typeof key === 'string').map(keyId));
    return this.enqueue(async () => {
      const removed = [];
      for (const [key, item] of this.index) {
        if (keep.has(key)) continue;
        this.index.delete(key);
        this.bytes -= item.bytes;
        removed.push(item.file);
      }
      await Promise.all([...new Set(removed)].map(file => unlink(join(this.dir, file)).catch(() => {})));
      let files = [];
      try { files = await readdir(this.dir); } catch { /* A missing cache directory is harmless. */ }
      const indexedFiles = new Set([...this.index.values()].map(item => item.file));
      const orphaned = files.filter(file => cacheFile.test(file) && !indexedFiles.has(file));
      await Promise.all(orphaned.map(file => unlink(join(this.dir, file)).catch(() => {})));
      if (removed.length || orphaned.length) await this.saveIndex();
      return { removed: removed.length + orphaned.length, bytes: this.bytes, items: this.index.size };
    });
  }
  async exportBundle() {
    await this.ready; await this.tail;
    const entries = [];
    for (const item of this.index.values()) {
      try {
        const body = await readFile(join(this.dir,item.file));
        if (body.length !== item.bytes || body.length > MAX_ITEM_BYTES) continue;
        entries.push({ key:item.key, type:item.type, bytes:item.bytes, fetchedAt:item.at, body:body.toString('base64') });
      } catch { /* A missing cache item is simply omitted from a migration package. */ }
    }
    const payload = { app:'fandu-cover-cache', version:1, exportedAt:new Date().toISOString(), entries };
    const bundle = {...payload, checksum:checksum(payload)};
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) throw Error('封面缓存包过大，请先减少本地缓存');
    return bundle;
  }
  async importBundle(bundle) {
    const entries=decodeCoverBundle(bundle);
    await this.ready;
    return this.enqueue(async () => {
      let added = 0, updated = 0;
      for (const item of entries) {
        const file = `${item.key}.${typeExt[item.type]}`, previous = this.index.get(item.key);
        if (previous) updated++; else added++;
        await atomicBytes(join(this.dir,file), item.body);
        if (previous) this.bytes -= previous.bytes;
        this.index.set(item.key,{key:item.key,file,type:item.type,bytes:item.bytes,at:item.at}); this.bytes += item.bytes;
      }
      await this.prune(false); await this.saveIndex();await syncDirectory(this.dir);
      return {added,updated,bytes:this.bytes,items:this.index.size};
    });
  }
  enqueue(task) {
    const next = this.tail.then(task);
    this.tail = next.catch(() => {});
    return next;
  }
}

export const COVER_CACHE_LIMITS = { maxItems:MAX_ITEMS, maxBytes:MAX_TOTAL_BYTES, maxItemBytes:MAX_ITEM_BYTES, maxBundleItems:MAX_BUNDLE_ITEMS, maxBundleBytes:MAX_BUNDLE_BYTES };
