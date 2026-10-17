import { mkdir, rename, open, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { validateLibrary, preferences, entry } from '../src/model.js';
import {librarySavePayload,librarySaveContent} from '../src/library-save.js';

export async function syncDirectory(dir) {
  // Windows does not expose fsync on directory handles through Node.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomicBytes(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    // Only remove this operation's staging file. Crashed writes are never read as archives.
    await unlink(temporary).catch(() => {});
  }
}
async function atomic(path, value) { return atomicBytes(path, Buffer.from(JSON.stringify(value))); }
const snapshotId = /^(?:backup-[0-2]|manual-[a-f0-9-]{36}|recovery-[a-f0-9-]{36})\.json$/;
export const MAX_MANUAL_SNAPSHOTS = 20;
export const LIBRARY_FORMAT_VERSION = 2;
export const MAX_ADD_RECEIPTS = 50;
export const MAX_SAVE_RECEIPTS = 50;
const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const publicLibrary = ({addReceipts,saveReceipts, ...value}) => value;
const conflict = message => Object.assign(Error(message), {status:409});
function validateAddReceipts(items, revision) {
  if (!Array.isArray(items) || items.length > MAX_ADD_RECEIPTS) throw Error('添加记录无效');
  const seen = new Set(),versions=new Set();
  for (const item of items) {
    if (!item || typeof item.requestId!=='string' || !requestIdPattern.test(item.requestId) || seen.has(item.requestId) || typeof item.fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) || typeof item.entryId !== 'string' || !/^[\w:.-]{1,100}$/.test(item.entryId) || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.revision > revision || versions.has(item.revision)) throw Error('添加记录无效');
    seen.add(item.requestId);versions.add(item.revision);
  }
  return items.map(({requestId,fingerprint,entryId,revision}) => ({requestId,fingerprint,entryId,revision}));
}
export function addRequest(value) {
  if (!value || typeof value.requestId!=='string' || !requestIdPattern.test(value.requestId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.entry?.id || typeof value.entry.createdAt !== 'string' || typeof value.entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.entry.createdAt)) || !Number.isFinite(Date.parse(value.entry.updatedAt))) throw Object.assign(Error('添加请求编号、版本或作品日期无效'), {status:400});
  let normalized;
  try { normalized = entry(value.entry); } catch (error) { error.status=400; throw error; }
  return {requestId:value.requestId,revision:value.revision,entry:normalized,fingerprint:createHash('sha256').update(JSON.stringify({revision:value.revision,entry:normalized})).digest('hex')};
}
export function librarySaveRequest(value){
  let payload;try{payload=librarySavePayload(value);}catch(error){error.status=400;throw error;}
  return {...payload,fingerprint:createHash('sha256').update(librarySaveContent(payload)).digest('hex')};
}
function validateSaveReceipts(items,revision){
  if(!Array.isArray(items)||items.length>MAX_SAVE_RECEIPTS)throw Error('保存记录无效');
  const ids=new Set(),versions=new Set();
  for(const item of items){
    if(!item||typeof item.requestId!=='string'||!requestIdPattern.test(item.requestId)||ids.has(item.requestId)||typeof item.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(item.fingerprint)||!Number.isSafeInteger(item.revision)||item.revision<1||item.revision>revision||versions.has(item.revision))throw Error('保存记录无效');
    ids.add(item.requestId);versions.add(item.revision);
  }
  return items.map(({requestId,fingerprint,revision})=>({requestId,fingerprint,revision}));
}
const digest = raw => createHash('sha256').update(raw === null ? 'missing:' : Buffer.concat([Buffer.from('file:'), raw])).digest('hex');
function decode(raw) {
  const v = JSON.parse(raw.toString('utf8'));
  const declared = v.formatVersion;
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1)) throw Error('Invalid format version');
  if (declared > LIBRARY_FORMAT_VERSION) {
    const error = Error(`档案格式 v${declared} 高于当前支持的 v${LIBRARY_FORMAT_VERSION}。请升级番渡后再打开，原档案不会被修改。`);
    error.code = 'FANDU_LIBRARY_TOO_NEW';
    error.formatVersion = declared;
    throw error;
  }
  if (!Number.isSafeInteger(v.revision) || v.revision < 0) throw Error('Invalid revision');
  // Files without a version are the original on-disk format. v0/v1 records
  // remain readable; the next successful write publishes v2 with receipts.
  const addReceipts=v.addReceipts===undefined?undefined:validateAddReceipts(v.addReceipts,v.revision),saveReceipts=v.saveReceipts===undefined?undefined:validateSaveReceipts(v.saveReceipts,v.revision);
  if(addReceipts?.some(item=>saveReceipts?.some(saved=>saved.requestId===item.requestId||saved.revision===item.revision)))throw Error('重复的操作记录');
  return { formatVersion:LIBRARY_FORMAT_VERSION, revision:v.revision, entries:validateLibrary(v.entries), settings:preferences(v.settings), ...(addReceipts?{addReceipts}:{}), ...(saveReceipts?{saveReceipts}:{}) };
}
async function snapshot(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw Error('档案超过 4 MB，需手动检查后恢复');
    const raw = buffer.subarray(0, size), stat = await handle.stat();
    let value = null, state = 'ok', error = '', formatVersion = null;
    try { value = decode(raw); }
    catch (cause) {
      // A newer archive is valid data, just not writable by this build. Keep
      // it distinct from corruption so the UI can direct users to upgrade.
      state = cause?.code === 'FANDU_LIBRARY_TOO_NEW' ? 'newer' : 'corrupt';
      error = cause?.message || '';
      formatVersion = cause?.formatVersion ?? null;
    }
    return { raw, value, token:digest(raw), createdAt:stat.mtime.toISOString(), state:value ? 'ok' : state, error, formatVersion };
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: null, value: null, token: digest(null), state: 'missing' };
    throw e;
  } finally { await handle?.close(); }
}
const summary = s => ({ token:s.token, state:s.state, createdAt:s.createdAt, revision:s.value?.revision ?? null, count:s.value?.entries.length ?? null, formatVersion:s.value?.formatVersion ?? s.formatVersion ?? null });
export class LibraryStore {
  constructor(dir) { this.dir = dir; this.tail = Promise.resolve(); }
  async read({withReceipts=false} = {}) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let current;
    try {
      current = await snapshot(join(this.dir, 'library.json'));
    } catch (e) {
      throw Error('档案文件无法读取，已停止写入。可在设置的数据管理中恢复本地快照。');
    }
    if (current.state === 'missing') {
      if ((await readdir(this.dir)).some(name => snapshotId.test(name))) throw Error('主档缺失，已暂停保存。可在设置的数据管理中恢复本地快照。');
      return { formatVersion:LIBRARY_FORMAT_VERSION, revision:0, entries:[], settings:preferences() };
    }
    if (current.state === 'newer') throw Error(current.error);
    if (!current.value) throw Error('档案文件无法读取，已停止写入。可在设置的数据管理中恢复本地快照。');
    return withReceipts ? current.value : publicLibrary(current.value);
  }
  async inspectBackups() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const current = await snapshot(join(this.dir, 'library.json'));
    const names = (await readdir(this.dir)).filter(name => snapshotId.test(name));
    const backups = [];
    for (const id of names) {
      try {
        const s = await snapshot(join(this.dir, id));
        if (s.state !== 'missing') backups.push({ id, kind: id.startsWith('backup-') ? 'auto' : id.startsWith('manual-') ? 'manual' : 'recovery', ...summary(s) });
      } catch { backups.push({ id, kind: id.startsWith('backup-') ? 'auto' : id.startsWith('manual-') ? 'manual' : 'recovery', state: 'unreadable' }); }
    }
    backups.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.id.localeCompare(b.id));
    return { current: summary(current), backups, limits:{ manual:MAX_MANUAL_SNAPSHOTS } };
  }
  async listBackups() { await this.tail; return this.inspectBackups(); }
  createSnapshot({requestId,currentToken} = {}) {
    const task = this.tail.then(async () => {
      const id=requestId===undefined?`manual-${randomUUID()}.json`:`manual-${requestId}.json`;
      if(!/^manual-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(id))throw Error('快照请求编号无效');
      if(requestId!==undefined && (typeof currentToken!=='string' || !/^[a-f0-9]{64}$/.test(currentToken)))throw Error('创建快照的确认版本无效');
      const existing=await snapshot(join(this.dir,id));
      if(existing.raw!==null){
        if(!currentToken || existing.token!==currentToken){const error=Error('快照编号已用于不同档案，未覆盖原快照');error.status=409;throw error;}
        await syncDirectory(this.dir);return this.inspectBackups();
      }
      const current = await snapshot(join(this.dir, 'library.json'));
      if (current.state !== 'ok' || !current.raw) throw Error('当前档案无法创建快照，请先恢复可用档案');
      if(currentToken && currentToken!==current.token){const error=Error('当前档案已变化，请刷新后再创建快照');error.status=409;throw error;}
      const catalog = await this.inspectBackups();
      const manualCount = catalog.backups.filter(item => item.kind === 'manual').length;
      if (manualCount >= MAX_MANUAL_SNAPSHOTS) throw Error(`手动快照最多保留 ${MAX_MANUAL_SNAPSHOTS} 份，请先删除旧快照`);
      // Preserve the exact bytes users chose to snapshot. This also avoids a
      // parse/stringify round trip changing formatting or Unicode escapes.
      await atomicBytes(join(this.dir, id), current.raw);
      return this.inspectBackups();
    });
    this.tail = task.catch(() => {});
    return task;
  }
  deleteBackup({ id, token } = {}) {
    const task = this.tail.then(async () => {
      if (typeof id !== 'string' || !snapshotId.test(id)) throw Error('备份编号无效');
      const path = join(this.dir, id);
      const selected = await snapshot(path);
      if (selected.state === 'missing') {await syncDirectory(this.dir);return this.inspectBackups();}
      if (token !== selected.token) {
        const e = Error('快照已变化，请刷新备份列表后重试'); e.status = 409; throw e;
      }
      const catalog = await this.inspectBackups();
      const listed = catalog.backups.find(item => item.id === id);
      if (!listed) throw Error('快照不存在，列表可能已过期');
      // Keep one valid recovery point so an accidental cleanup can never
      // remove the final usable way back into the archive.
      if (selected.state === 'ok' && catalog.backups.filter(item => item.state === 'ok').length <= 1) {
        throw Error('至少保留一个可恢复快照，不能删除最后一份');
      }
      await unlink(path);
      await syncDirectory(this.dir);
      return this.inspectBackups();
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async restorationPlan({ id, token, currentToken } = {}) {
    if(typeof id!=='string' || !snapshotId.test(id))throw Error('备份编号无效');
    const selected=await snapshot(join(this.dir,id)),before=await snapshot(join(this.dir,'library.json'));
    if(selected.state!=='ok')throw Error('备份缺失或已损坏，不能恢复');
    if(token!==selected.token || currentToken!==before.token){const error=Error('档案或备份已变化，请刷新备份列表后重新确认');error.status=409;throw error;}
    const catalog=await this.inspectBackups();
    if(before.raw!==null && catalog.backups.filter(item=>item.kind==='recovery').length>=20)throw Error('恢复保护档案已达 20 份，请先归档旧副本');
    const revision=Math.max(Date.now(),before.value?.revision || 0,...catalog.backups.map(item=>item.revision || 0))+1;
    if(!Number.isSafeInteger(revision))throw Error('档案版本超出范围，需手动检查');
    return {library:{...selected.value,revision},beforeToken:before.token,recoveryId:before.raw===null?null:`recovery-${randomUUID()}.json`};
  }
  async inspectCurrent(){const value=await snapshot(join(this.dir,'library.json'));return {value:value.value && publicLibrary(value.value),token:value.token,state:value.state};}
  async preserveOriginal(before,recoveryId){
    if(!recoveryId)return;
    if(!/^recovery-[a-f0-9-]{36}\.json$/.test(recoveryId))throw Error('恢复保护编号无效');
    const previous=await snapshot(join(this.dir,recoveryId));
    if(previous.raw!==null && previous.token!==before.token)throw Error('恢复保护副本已变化，已停止写入');
    if(before.raw!==null && previous.raw===null){
      const catalog=await this.inspectBackups();
      if(catalog.backups.filter(item=>item.kind==='recovery').length>=20)throw Error('恢复保护档案已达 20 份，请先归档旧副本');
      await atomicBytes(join(this.dir,recoveryId),before.raw);
    }else if(previous.raw!==null)await syncDirectory(this.dir);
  }
  async writeRestoration({library,beforeToken,recoveryId}){
    const before=await snapshot(join(this.dir,'library.json'));
    if(before.token!==beforeToken){const error=Error('当前档案已变化，已停止恢复');error.status=409;throw error;}
    if(!Number.isSafeInteger(library?.revision) || library.revision<1)throw Error('恢复版本无效');
    const next={formatVersion:LIBRARY_FORMAT_VERSION,revision:library.revision,entries:validateLibrary(library.entries),settings:preferences(library.settings)};
    await this.preserveOriginal(before,recoveryId);
    await atomic(join(this.dir,'library.json'),next);
    return {library:next,preserved:before.raw===null?null:recoveryId};
  }
  applyRestoration(plan){const task=this.tail.then(()=>this.writeRestoration(plan));this.tail=task.catch(()=>{});return task;}
  restore(selection) {
    const task = this.tail.then(async () => {
      return this.writeRestoration(await this.restorationPlan(selection));
    });
    this.tail = task.catch(() => {});
    return task;
  }
  save(value, { currentToken, recoveryId } = {}) {
    const task = this.tail.then(async () => {
      const current = await this.read({withReceipts:true});
      if (value.revision !== current.revision) { const err = Error('其他窗口已修改档案，请刷新后重试。'); err.status = 409; throw err; }
      const entries = validateLibrary(value.entries);
      const next = { ...current, formatVersion:LIBRARY_FORMAT_VERSION, revision:current.revision + 1, entries, settings:preferences(value.settings ?? current.settings) };
      if (!Number.isSafeInteger(next.revision)) throw Error('档案版本超出范围，需手动检查');
      if(currentToken || recoveryId){
        const before=await snapshot(join(this.dir,'library.json'));
        if(before.token!==currentToken){const error=Error('档案已变化，请重新核对导入预览');error.status=409;throw error;}
        await this.preserveOriginal(before,recoveryId);
      }
      // Three bounded, rotating snapshots. Never overwrite a corrupt library.
      if (current.revision) await atomic(join(this.dir, `backup-${current.revision % 3}.json`), current);
      await atomic(join(this.dir, 'library.json'), next);
      return publicLibrary(next);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  addEntry(value) {
    const task = this.tail.then(async () => {
      const request = addRequest(value), current = await this.read({withReceipts:true});
      if(current.saveReceipts?.some(item=>item.requestId===request.requestId))throw conflict('该编号已用于保存，不能用于添加');
      const previous = current.addReceipts?.find(item => item.requestId === request.requestId);
      if (previous) {
        if (previous.fingerprint !== request.fingerprint) throw conflict('相同添加编号不能用于不同内容');
        try { await syncDirectory(this.dir); } catch (error) { error.status=503; throw error; }
        return {state:'completed',requestId:previous.requestId,entryId:previous.entryId,revision:previous.revision,replayed:true,library:publicLibrary(current)};
      }
      if (request.revision !== current.revision) throw conflict('其他窗口已修改档案，请刷新后重新核对。草稿仍保留。');
      if (current.entries.some(item => item.id === request.entry.id || request.entry.sourceId && item.sourceId === request.entry.sourceId)) throw conflict('这部作品已在收藏中，未覆盖已有记录。');
      let entries;
      try { entries=validateLibrary([...current.entries,request.entry]); } catch (error) { error.status=400; throw error; }
      const revision=current.revision+1;
      if (!Number.isSafeInteger(revision)) throw Object.assign(Error('档案版本超出范围'),{status:400});
      const receipt={requestId:request.requestId,fingerprint:request.fingerprint,entryId:request.entry.id,revision};
      const next={...current,revision,entries,addReceipts:[...(current.addReceipts || []),receipt].slice(-MAX_ADD_RECEIPTS)};
      // The work and its receipt share one atomic file replacement. A lost
      // response can be confirmed without recreating or undoing later edits.
      try {
        if (current.revision) await atomic(join(this.dir,`backup-${current.revision % 3}.json`),current);
        await atomic(join(this.dir,'library.json'),next);
      } catch (error) { error.status=503; throw error; }
      return {state:'completed',requestId:receipt.requestId,entryId:receipt.entryId,revision,replayed:false,library:publicLibrary(next)};
    });
    this.tail=task.catch(()=>{});return task;
  }
  additionStatus(requestId) {
    const task=this.tail.then(async()=>{
      if (typeof requestId!=='string'||!requestIdPattern.test(requestId)) throw Object.assign(Error('添加请求编号无效'),{status:400});
      const current=await this.read({withReceipts:true}),receipt=current.addReceipts?.find(item=>item.requestId===requestId);
      if (!receipt) return {state:'unknown',requestId};
      try { await syncDirectory(this.dir); } catch (error) { error.status=503; throw error; }
      return {state:'completed',requestId,entryId:receipt.entryId,revision:receipt.revision,replayed:true,library:publicLibrary(current)};
    });
    this.tail=task.catch(()=>{});return task;
  }
  saveWithReceipt(value){
    const task=this.tail.then(async()=>{
      const request=librarySaveRequest(value),current=await this.read({withReceipts:true});
      if(current.addReceipts?.some(item=>item.requestId===request.requestId))throw conflict('该编号已用于添加，不能用于保存');
      const previous=current.saveReceipts?.find(item=>item.requestId===request.requestId);
      if(previous){
        if(previous.fingerprint!==request.fingerprint)throw conflict('相同保存编号不能用于不同内容');
        try{await syncDirectory(this.dir);}catch(error){error.status=503;throw error;}
        return {state:'completed',...previous,replayed:true,library:publicLibrary(current)};
      }
      if(request.revision!==current.revision)throw conflict('其他窗口已修改档案，请重新核对。当前修改仍保留。');
      const revision=current.revision+1;
      if(!Number.isSafeInteger(revision))throw Object.assign(Error('档案版本超出范围，需手动检查'),{status:400});
      const receipt={requestId:request.requestId,fingerprint:request.fingerprint,revision};
      const next={...current,formatVersion:LIBRARY_FORMAT_VERSION,revision,entries:request.entries,settings:request.settings,saveReceipts:[...(current.saveReceipts||[]),receipt].slice(-MAX_SAVE_RECEIPTS)};
      // Contents and proof of completion are published by the same rename.
      // A retry only returns the current archive; it never replays old fields.
      try{
        if(current.revision)await atomic(join(this.dir,`backup-${current.revision%3}.json`),current);
        await atomic(join(this.dir,'library.json'),next);
      }catch(error){error.status=503;throw error;}
      return {state:'completed',...receipt,replayed:false,library:publicLibrary(next)};
    });
    this.tail=task.catch(()=>{});return task;
  }
  saveStatus(requestId){
    const task=this.tail.then(async()=>{
      if(typeof requestId!=='string'||!requestIdPattern.test(requestId))throw Object.assign(Error('保存请求编号无效'),{status:400});
      const current=await this.read({withReceipts:true}),receipt=current.saveReceipts?.find(item=>item.requestId===requestId);
      if(!receipt)return {state:'unknown',requestId,currentRevision:current.revision};
      try{await syncDirectory(this.dir);}catch(error){error.status=503;throw error;}
      return {state:'completed',...receipt,replayed:true,library:publicLibrary(current)};
    });
    this.tail=task.catch(()=>{});return task;
  }
}
