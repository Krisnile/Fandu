import {createHash,randomUUID} from 'node:crypto';
import {open,unlink,rename,readdir,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {atomicBytes,syncDirectory,LIBRARY_FORMAT_VERSION} from './store.mjs';
import {decodeCoverBundle} from './cover-cache.mjs';
import {validateLibrary,preferences,MAX_BYTES} from '../src/model.js';
import {MAX_TRANSFER_BYTES} from '../src/backup.js';
import {decodeEntryDraftState,ENTRY_DRAFT_MAX_BYTES} from './drafts.mjs';

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validId=value=>typeof value==='string'&&idPattern.test(value);
const validToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validRecovery=value=>value===null||typeof value==='string'&&/^recovery-[a-f0-9-]{36}\.json$/.test(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict=message=>Object.assign(Error(message),{status:409});
const receiptLimit=20;
const quarantineLimit=20;
const recordNames={pending:'migration-pending.json',receipts:'migration-receipts.json',drafts:'entry-drafts.json'};
const recordLimits={pending:MAX_TRANSFER_BYTES+MAX_BYTES+4096,receipts:128*1024,drafts:ENTRY_DRAFT_MAX_BYTES};
const rawDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
function restoreSelection(value){
  if(!value || !validId(value.requestId) || typeof value.id!=='string'|| !/^(?:backup-[0-2]|manual-[a-f0-9-]{36}|recovery-[a-f0-9-]{36})\.json$/.test(value.id) || !validToken(value.token) || !validToken(value.currentToken))throw Error('恢复请求或确认版本无效');
  return {kind:'restore',id:value.id,token:value.token,currentToken:value.currentToken};
}
async function readBytes(path,limit){
  let handle;
  try{
    if(!(await lstat(path)).isFile())throw Error('迁移记录路径不是普通文件，请检查数据目录；未改动原路径');
    handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const chunks=[];let size=0;
    while(size<=limit){
      const chunk=Buffer.alloc(Math.min(64*1024,limit+1-size));
      const {bytesRead}=await handle.read(chunk,0,chunk.length,null);
      if(!bytesRead)break;
      size+=bytesRead;chunks.push(chunk.subarray(0,bytesRead));
    }
    if(size>limit)throw Error('迁移记录超过读取上限，已停止写入');
    return Buffer.concat(chunks);
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
  finally{await handle?.close();}
}
async function readJson(path,limit){const bytes=await readBytes(path,limit);if(bytes===null)return null;try{const value=JSON.parse(bytes.toString('utf8'));if(value===null)throw Error('Invalid record');return value;}catch{throw Error('迁移记录损坏，原文件已保留，已停止写入');}}
async function writeChecked(path,payload){
  await atomicBytes(path,Buffer.from(JSON.stringify({...payload,checksum:digest(payload)})));
}
function checked(value,app){
  if(value?.app===app&&Number.isSafeInteger(value.version)&&value.version>1)throw Object.assign(Error('迁移记录来自较新版本，请升级番渡；原记录已保留'),{code:'FANDU_MIGRATION_TOO_NEW'});
  if(!value || value.app!==app || value.version!==1 || typeof value.checksum!=='string')throw Error('迁移记录格式无效，已停止写入');
  const {checksum,...payload}=value;
  if(checksum!==digest(payload))throw Error('迁移记录校验失败，已保留原文件并停止写入');
  return payload;
}
function requestValue(value){
  if(!value || !validId(value.requestId) || !Number.isSafeInteger(value.revision) || value.revision<0)throw Error('导入请求编号或档案版本无效');
  // Missing timestamps must not make an identical retry hash differently.
  const entries=validateLibrary(Array.isArray(value.entries)?value.entries.map(item=>({...item,updatedAt:Number.isFinite(Date.parse(item?.updatedAt))?item.updatedAt:'1970-01-01T00:00:00.000Z'})):value.entries);
  const request={revision:value.revision,entries,settings:preferences(value.settings),covers:value.covers ?? null};
  if(request.covers)decodeCoverBundle(request.covers);
  if(Buffer.byteLength(JSON.stringify(request))>MAX_TRANSFER_BYTES)throw Error('导入文件过大');
  return request;
}

// A durable roll-forward transaction, not a claim of a filesystem-wide atomic
// rename. All public storage tasks share this queue. A pending decision must
// complete before another task can read/prune or modify the archive/cache.
export class MigrationCoordinator {
  constructor({dir,store,covers,onStage=async()=>{}}){
    this.dir=dir;this.store=store;this.covers=covers;this.onStage=onStage;this.tail=Promise.resolve();
    this.journalPath=join(dir,'migration-pending.json');this.receiptPath=join(dir,'migration-receipts.json');
  }
  enqueue(task){const next=this.tail.then(task);this.tail=next.catch(()=>{});return next;}
  run(task){return this.enqueue(async()=>{
    try{await this.recover();}catch(error){error.status=503;error.migrationPending=true;throw error;}
    return task();
  });}
  async receipts(raw=undefined){
    if(raw===undefined)raw=await readJson(this.receiptPath,recordLimits.receipts);
    if(raw===null)return [];
    const value=checked(raw,'fandu-migration-receipts'),seen=new Set();
    if(!Array.isArray(value.items) || value.items.length>receiptLimit)throw Error('迁移回执无效，已停止写入');
    for(const item of value.items){
      if(!item||typeof item!=='object'||Array.isArray(item))throw Error('迁移回执内容无效，已停止写入');
      if(item.kind!==undefined && !['import','restore'].includes(item.kind))throw Error('迁移回执操作类型无效，已停止写入');
      if(!validId(item.requestId) || seen.has(item.requestId) || !validToken(item.fingerprint) || !Number.isSafeInteger(item.revision) || item.revision<1 || !Number.isSafeInteger(item.coverCount) || item.coverCount<0 || item.coverCount>1200 || !validRecovery(item.preserved))throw Error('迁移回执无效，已停止写入');
      seen.add(item.requestId);
    }
    return value.items;
  }
  async journal(raw=undefined){
    if(raw===undefined)raw=await readJson(this.journalPath,recordLimits.pending);
    if(raw===null)return null;
    const value=checked(raw,'fandu-migration');
    if(!validId(value.requestId) || !validToken(value.beforeToken) || !validRecovery(value.recoveryId))throw Error('迁移记录内容无效，已停止写入');
    const request=requestValue({...value.request,requestId:value.requestId});
    if(value.kind!==undefined && !['import','restore'].includes(value.kind))throw Error('待恢复操作类型无效，已停止写入');
    const fingerprint=value.kind==='restore'?digest(restoreSelection({...value.selection,requestId:value.requestId})):digest(request);
    if(fingerprint!==value.fingerprint || value.kind==='restore' && (request.covers!==null || value.beforeToken!==value.selection.currentToken))throw Error('迁移意图校验失败，已停止写入');
    return {...value,request};
  }
  async inspectRecord(id){
    let bytes;
    try{bytes=await readBytes(join(this.dir,recordNames[id]),recordLimits[id]);}
    catch(error){return {id,name:recordNames[id],state:'unreadable',error:error.message,repairable:false,token:null};}
    if(bytes===null)return {id,name:recordNames[id],state:'missing',repairable:false,token:null,bytes:0};
    const result={id,name:recordNames[id],bytes:bytes.length,token:rawDigest(bytes)};
    try{
      const raw=JSON.parse(bytes.toString('utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('迁移记录格式无效，原文件已保留');
      const value=await (id==='pending'?this.journal(raw):id==='drafts'?decodeEntryDraftState(raw):this.receipts(raw));
      return {...result,state:'ok',repairable:false,...(id==='pending'?{kind:value.kind||'import',requestId:value.requestId}:{count:id==='drafts'?value.items.length:value.length})};
    }catch(error){const newer=['FANDU_MIGRATION_TOO_NEW','FANDU_ENTRY_DRAFT_TOO_NEW'].includes(error.code);return {...result,state:newer?'newer':'damaged',error:error instanceof SyntaxError?'恢复记录不是有效的 JSON，原文件仍保留':error.message,repairable:!newer};}
  }
  async inspectDiagnostics(){
    const records=await Promise.all(Object.keys(recordNames).map(id=>this.inspectRecord(id))),current=await this.store.inspectCurrent();
    const quarantined=(await readdir(this.dir)).filter(name=>/^migration-quarantine-[a-f0-9-]{36}-(pending|receipts|drafts)\.bin$/.test(name));
    return {records,current:{state:current.state,token:current.token,revision:current.value?.revision??null,entries:current.value?.entries.length??null},quarantined:quarantined.length,limit:quarantineLimit};
  }
  diagnostics(){return this.enqueue(()=>this.inspectDiagnostics());}
  exportDiagnostics(){return this.enqueue(async()=>{
    const files=[];
    for(const [name,limit] of [...Object.keys(recordNames).map(id=>[recordNames[id],recordLimits[id]]),['library.json',MAX_BYTES+4096]]){
      const bytes=await readBytes(join(this.dir,name),limit);if(bytes!==null)files.push({name,encoding:'base64',bytes:bytes.length,sha256:rawDigest(bytes),data:bytes.toString('base64')});
    }
    return {app:'fandu-migration-diagnostic',version:1,createdAt:new Date().toISOString(),files,summary:await this.inspectDiagnostics()};
  });}
  retryRecovery(){return this.enqueue(async()=>{
    let error='';try{await this.recover();}catch(cause){error=cause.message;}
    return {state:error?'pending':'completed',error,diagnostics:await this.inspectDiagnostics()};
  });}
  quarantine(value){
    if(!value||typeof value.requestId!=='string'||!idPattern.test(value.requestId)||typeof value.id!=='string'||!Object.hasOwn(recordNames,value.id)||typeof value.token!=='string'||!/^[a-f0-9]{64}$/.test(value.token)||typeof value.currentToken!=='string'||!/^[a-f0-9]{64}$/.test(value.currentToken))throw Error('隔离请求或确认版本无效');
    const {id,requestId,token,currentToken}=value,preserved=`migration-quarantine-${requestId}-${id}.bin`,target=join(this.dir,preserved);
    return this.enqueue(async()=>{
      try{
      const previous=await readBytes(target,recordLimits[id]);
      if(previous!==null){
        if(rawDigest(previous)!==token)throw conflict('隔离编号对应不同内容，未覆盖保护副本');
        await syncDirectory(this.dir);return {state:'quarantined',requestId,preserved,replayed:true,diagnostics:await this.inspectDiagnostics()};
      }
      const record=await this.inspectRecord(id),current=await this.store.inspectCurrent();
      if(!record.repairable)throw conflict(record.state==='newer'?'请升级番渡，不能隔离较新版本记录':'该记录不是明确损坏的记录，未隔离');
      if(record.token!==token||current.token!==currentToken)throw conflict('记录或当前档案已变化，请重新检查后确认隔离');
      if((await this.inspectDiagnostics()).quarantined>=quarantineLimit)throw Error(`已保留 ${quarantineLimit} 份迁移保护记录，请先在数据目录归档旧副本`);
      await this.onStage('diagnostic-prepared');
      const confirmed=await this.inspectRecord(id),confirmedCurrent=await this.store.inspectCurrent();
      if(!confirmed.repairable||confirmed.token!==token||confirmedCurrent.token!==currentToken)throw conflict('记录或当前档案已变化，未隔离；请重新检查后确认');
      // Same-directory rename keeps the exact original bytes recoverable. A
      // retry proves the preserved file and syncs the directory, not a second
      // deletion or an automatic replay of the discarded migration.
      await rename(join(this.dir,recordNames[id]),target);
      await this.onStage('diagnostic-moved');
      await syncDirectory(this.dir);
      return {state:'quarantined',requestId,preserved,replayed:false,diagnostics:await this.inspectDiagnostics()};
      }catch(error){if(error.status!==409)error.status=503;throw error;}
    });
  }
  async removeJournal(){await unlink(this.journalPath).catch(error=>{if(error.code!=='ENOENT')throw error;});await syncDirectory(this.dir);}
  async recover(){
    const journal=await this.journal();
    if(!journal)return;
    try{
      const receipts=await this.receipts(),receipt=receipts.find(item=>item.requestId===journal.requestId);
      if(receipt){
        if(receipt.fingerprint!==journal.fingerprint)throw Error('迁移回执与待恢复记录不一致');
        await this.removeJournal();return;
      }
      const {request}=journal;
      const desired={formatVersion:LIBRARY_FORMAT_VERSION,revision:request.revision+1,entries:request.entries,settings:request.settings};
      if(!Number.isSafeInteger(desired.revision))throw Error('档案版本超出范围');
      const inspection=await this.store.inspectCurrent();
      const current=journal.kind==='restore'?inspection.value:await this.store.read();
      const alreadySaved=digest(current)===digest(desired);
      if(!alreadySaved){
        const catalog=await this.store.listBackups();
        if((journal.kind!=='restore' && current.revision!==request.revision) || catalog.current.token!==journal.beforeToken)throw conflict('待恢复操作与当前档案不一致，已停止写入，请保留数据目录进行检查');
      }
      if(request.covers)await this.covers.importBundle(request.covers);
      await this.onStage('covers');
      if(!alreadySaved){
        if(journal.kind==='restore')await this.store.applyRestoration({library:desired,beforeToken:journal.beforeToken,recoveryId:journal.recoveryId});
        else await this.store.save(request,{currentToken:journal.beforeToken,recoveryId:journal.recoveryId});
      }
      else await syncDirectory(this.dir);
      await this.onStage('archive');
      const completed={requestId:journal.requestId,kind:journal.kind || 'import',fingerprint:journal.fingerprint,revision:desired.revision,preserved:journal.recoveryId,coverCount:request.covers?.entries.length || 0,completedAt:new Date().toISOString()};
      await writeChecked(this.receiptPath,{app:'fandu-migration-receipts',version:1,items:[...receipts,completed].slice(-receiptLimit)});
      await this.onStage('receipt');
      await this.removeJournal();
    }catch(error){error.migrationPending=true;error.status=503;throw error;}
  }
  restore(value){
    const selection=restoreSelection(value),fingerprint=digest(selection),requestId=value.requestId;
    return this.enqueue(async()=>{
      await this.recover();
      const previous=(await this.receipts()).find(item=>item.requestId===requestId);
      if(previous){
        if(previous.kind!=='restore' || previous.fingerprint!==fingerprint)throw conflict('相同恢复编号不能用于不同快照或确认版本');
        return {...previous,library:await this.store.read(),replayed:true};
      }
      const plan=await this.store.restorationPlan(selection);
      const request=requestValue({requestId,revision:plan.library.revision-1,entries:plan.library.entries,settings:plan.library.settings,covers:null});
      await writeChecked(this.journalPath,{app:'fandu-migration',version:1,kind:'restore',selection,requestId,fingerprint,request,beforeToken:plan.beforeToken,recoveryId:plan.recoveryId});
      await this.onStage('prepared');await this.recover();
      const receipt=(await this.receipts()).find(item=>item.requestId===requestId);
      return {...receipt,library:await this.store.read(),replayed:false};
    });
  }
  import(value){
    const request=requestValue(value),fingerprint=digest(request),requestId=value.requestId;
    return this.enqueue(async()=>{
      await this.recover();
      const receipts=await this.receipts(),previous=receipts.find(item=>item.requestId===requestId);
      if(previous){
        if(previous.kind==='restore' || previous.fingerprint!==fingerprint)throw conflict('相同导入编号不能用于不同内容');
        return {...previous,library:await this.store.read(),replayed:true};
      }
      const current=await this.store.read();
      if(current.revision!==request.revision)throw conflict('其他窗口已修改档案，请刷新后重新核对导入预览');
      if(!Number.isSafeInteger(request.revision+1))throw Error('档案版本超出范围');
      const catalog=await this.store.listBackups();
      if(catalog.backups.filter(item=>item.kind==='recovery').length>=20)throw Error('恢复保护档案已达 20 份，请先归档旧副本');
      const journal={app:'fandu-migration',version:1,requestId,fingerprint,request,beforeToken:catalog.current.token,recoveryId:catalog.current.state==='missing'?null:`recovery-${randomUUID()}.json`};
      await writeChecked(this.journalPath,journal);
      await this.onStage('prepared');
      await this.recover();
      const receipt=(await this.receipts()).find(item=>item.requestId===requestId);
      return {...receipt,library:await this.store.read(),replayed:false};
    });
  }
  status(requestId){
    if(!validId(requestId))throw Error('导入请求编号无效');
    return this.enqueue(async()=>{
      try{await this.recover();}
      catch(error){return {state:'pending',requestId,error:error.message};}
      const receipt=(await this.receipts()).find(item=>item.requestId===requestId);
      return receipt?{state:'committed',result:{...receipt,library:await this.store.read(),replayed:true}}:{state:'unknown'};
    });
  }
}
