import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicBytes,syncDirectory,addRequest} from './store.mjs';
import {entry} from '../src/model.js';

export const MAX_ENTRY_DRAFTS=20;
export const MAX_DISCARDED_DRAFT_IDS=256;
export const ENTRY_DRAFT_MAX_BYTES=2*1024*1024;
const maxBytes=ENTRY_DRAFT_MAX_BYTES;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validId=id=>typeof id==='string'&&(uuidPattern.test(id)||(id.length===73&&id[36]===':'&&uuidPattern.test(id.slice(0,36))&&uuidPattern.test(id.slice(37))));
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict=message=>Object.assign(Error(message),{status:409});
const fields={title:120,type:16,status:16,total:16,progress:16,year:16,customCover:2048,description:1200,note:4000,seriesId:60,season:16,region:30,originalTitle:160,aliases:1000,tags:2048,lists:160};
function string(value,limit){if(typeof value!=='string'||value.length>limit)throw Object.assign(Error('添加草稿字段无效或过长'),{status:400});return value;}
function normalizedDraft(value){
  if(!value || !['form','detail'].includes(value.kind))throw Object.assign(Error('添加草稿类型无效'),{status:400});
  const seed=value.seed===null || value.seed===undefined?null:entry(value.seed);
  if(value.kind==='detail'){if(!seed)throw Object.assign(Error('收录草稿缺少作品'),{status:400});return {kind:'detail',seed};}
  if(!value.values || typeof value.values!=='object' || Array.isArray(value.values) || !Array.isArray(value.lists) || value.lists.length>24)throw Object.assign(Error('添加草稿无效'),{status:400});
  const values={};for(const key of Object.keys(fields))if(Object.hasOwn(value.values,key))values[key]=string(value.values[key],fields[key]);
  return {kind:'form',values,lists:value.lists.map(id=>string(id,160)),seed,enrichQuery:string(value.enrichQuery || '',120),baseline:string(value.baseline || '',32*1024)};
}
function normalizedIntent(value){if(value===null || value===undefined)return null;const {requestId,revision,entry}=addRequest(value);return {requestId,revision,entry};}
const same=(a,b)=>fingerprint(a)===fingerprint(b);
export function decodeEntryDraftState(raw){
  if(raw&&Number.isSafeInteger(raw.formatVersion)&&raw.formatVersion>2)throw Object.assign(Error('录入草稿来自较新版本，请升级番渡；原记录已保留'),{code:'FANDU_ENTRY_DRAFT_TOO_NEW'});
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('录入草稿格式无效');
  const {checksum,...payload}=raw;
  if(![1,2].includes(payload.formatVersion)||checksum!==fingerprint(payload)||!Array.isArray(payload.items)||payload.items.length>MAX_ENTRY_DRAFTS)throw Error('添加草稿记录校验失败');
  const epoch=payload.formatVersion===2?payload.epoch:null;
  if(payload.formatVersion===2&&(typeof epoch!=='string'||!uuidPattern.test(epoch)))throw Error('添加草稿代号无效');
  const discardedIds=payload.formatVersion===1?(payload.discardedIds??[]):payload.discardedIds;
  if(!Array.isArray(discardedIds)||discardedIds.length>(epoch?MAX_DISCARDED_DRAFT_IDS:20000)||discardedIds.some(id=>epoch?(!validId(id)||!id.startsWith(epoch+':')):(typeof id!=='string'||!uuidPattern.test(id)))||new Set(discardedIds).size!==discardedIds.length)throw Error('已丢弃草稿记录无效');
  const seen=new Set(),items=payload.items.map(item=>{
    if(!item||!validId(item.id)||(!epoch&&!uuidPattern.test(item.id))||seen.has(item.id)||discardedIds.includes(item.id)||!Number.isSafeInteger(item.version)||item.version<1||typeof item.updatedAt!=='string'||!Number.isFinite(Date.parse(item.updatedAt)))throw Error('添加草稿记录无效');
    seen.add(item.id);return {id:item.id,version:item.version,draft:normalizedDraft(item.draft),intent:normalizedIntent(item.intent),updatedAt:item.updatedAt};
  });
  return {items,discardedIds,epoch};
}

// Recovery data is separate from the portable collection. Drafts may contain
// deliberately invalid inputs; a prepared intent is immutable until the
// server has made a definite decision. All API access uses the storage queue.
export class EntryDraftStore {
  constructor(dir,store){this.path=join(dir,'entry-drafts.json');this.dir=dir;this.store=store;}
  async readState(){
    let handle;
    try{
      handle=await open(this.path,'r');const chunks=[];let size=0;
      while(size<=maxBytes){const chunk=Buffer.alloc(Math.min(64*1024,maxBytes+1-size));const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;size+=bytesRead;chunks.push(chunk.subarray(0,bytesRead));}
      if(size>maxBytes)throw Error('添加草稿超过读取上限');
      return decodeEntryDraftState(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }catch(error){if(error.code==='ENOENT')return {items:[],discardedIds:[],epoch:null};throw Object.assign(Error(error.code==='FANDU_ENTRY_DRAFT_TOO_NEW'?error.message:'未能读取添加草稿，原记录已保留。请检查恢复记录。'),{status:503,draftRecovery:true,code:error.code});}
    finally{await handle?.close();}
  }
  async read(){return (await this.readState()).items;}
  async write(items,discardedIds=[],epoch){
    if(typeof epoch!=='string'||!uuidPattern.test(epoch)||discardedIds.length>MAX_DISCARDED_DRAFT_IDS)throw Object.assign(Error('添加草稿代号或结束记录无效'),{status:400});
    const payload={formatVersion:2,epoch,items,discardedIds},bytes=Buffer.from(JSON.stringify({...payload,checksum:fingerprint(payload)}));
    if(bytes.length>maxBytes)throw Object.assign(Error('添加草稿已达容量上限，请先完成旧草稿'),{status:400});
    try{await atomicBytes(this.path,bytes);}catch(error){error.status=503;throw error;}
  }
  async allocate(){
    let {items,discardedIds,epoch}=await this.readState();
    // Only the new namespace can create absent records. Legacy active drafts
    // retain their identity, while all absent legacy IDs become uncreatable.
    if(!epoch){epoch=randomUUID();discardedIds=[];await this.write(items,discardedIds,epoch);}
    await syncDirectory(this.dir);
    return {id:epoch+':'+randomUUID(),version:0};
  }
  async save(value){
    if(!validId(value?.id)||!Number.isSafeInteger(value.version)||value.version<0)throw Object.assign(Error('添加草稿编号或版本无效'),{status:400});
    const draft=normalizedDraft(value.draft),intent=normalizedIntent(value.intent),{items,discardedIds,epoch}=await this.readState(),previous=items.find(item=>item.id===value.id);
    if(discardedIds.includes(value.id))throw conflict('这份草稿已经结束，未重新创建。可将当前内容保留为另一份草稿。');
    if(!previous&&(!epoch||!value.id.startsWith(epoch+':')))throw conflict('这份未保存草稿的编号已过期。当前输入仍保留，可保留为另一份草稿。');
    if(previous && same(previous.draft,draft) && same(previous.intent,intent) && (previous.intent || value.version===previous.version-1)) {await syncDirectory(this.dir);return previous;}
    if((previous?.version || 0)!==value.version)throw conflict('其他窗口已修改这份草稿，当前输入仍保留。请重新读取草稿核对。');
    if(previous?.intent)throw conflict('这次添加尚未确认，不能修改已准备的内容');
    if(!previous && items.length>=MAX_ENTRY_DRAFTS)throw Object.assign(Error(`最多保留 ${MAX_ENTRY_DRAFTS} 份未完成添加，请先处理旧草稿`),{status:400});
    const version=value.version+1;if(!Number.isSafeInteger(version))throw Object.assign(Error('草稿版本超出范围'),{status:400});
    const record={id:value.id,version,draft,intent,updatedAt:new Date().toISOString()};
    await this.write([...items.filter(item=>item.id!==value.id),record],epoch?discardedIds:[],epoch||randomUUID());return record;
  }
  async assertIntent(id,payload){
    const record=(await this.read()).find(item=>item.id===id),request=addRequest(payload);
    if(!record?.intent || addRequest(record.intent).fingerprint!==request.fingerprint || record.intent.requestId!==request.requestId)throw conflict('添加内容已变化或未准备完成，未写入收藏');
    return record;
  }
  async reject(id,requestId){
    const {items,discardedIds,epoch}=await this.readState(),record=items.find(item=>item.id===id);
    if(record?.intent?.requestId!==requestId)return;
    if(!Number.isSafeInteger(record.version+1))throw Object.assign(Error('草稿版本超出范围'),{status:400});
    record.intent=null;record.version++;record.updatedAt=new Date().toISOString();await this.write(items,epoch?discardedIds:[],epoch||randomUUID());
  }
  async remove({id,version,requestId,draft}={}){
    if(!validId(id))throw Object.assign(Error('添加草稿编号无效'),{status:400});
    let {items,discardedIds,epoch}=await this.readState();const record=items.find(item=>item.id===id);
    if(!record&&(!epoch||!id.startsWith(epoch+':')||discardedIds.includes(id))){await syncDirectory(this.dir);return {removed:true};}
    if(record?.intent){
      if(requestId!==record.intent.requestId || (await this.store.additionStatus(requestId)).state!=='completed')throw conflict('添加结果尚未确认，不能丢弃这次操作');
    }else if(record&&record.version!==version && !(record.version===version+1 && draft && same(record.draft,normalizedDraft(draft))))throw conflict('其他窗口已修改这份草稿，未删除');
    if(!epoch){epoch=randomUUID();discardedIds=[];}
    if(id.startsWith(epoch+':'))discardedIds=[...discardedIds,id];
    // Switching namespaces rejects every absent old-generation ID, including
    // never-saved allocations. Existing drafts remain valid across rotation.
    if(discardedIds.length>=MAX_DISCARDED_DRAFT_IDS){epoch=randomUUID();discardedIds=[];}
    await this.write(items.filter(item=>item.id!==id),discardedIds,epoch);return {removed:true};
  }
}
