import {librarySavePayload,librarySaveFingerprint} from './library-save.js';
import {entry} from './model.js';
import {libraryCommand} from './library-command.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const EDIT_RECOVERY_LIMITS={intents:20,drafts:64,bytes:16*1024*1024,draftBytes:64*1024};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function recoveryRecord(value){
  if(value?.format>2)throw Object.assign(Error('编辑恢复记录来自较新版本，请刷新或升级番渡，原记录已保留'),{code:'FANDU_EDIT_RECOVERY_TOO_NEW'});
  if(!object(value)||![1,2].includes(value.format)||typeof value.id!=='string'||!uuid.test(value.id)||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))throw Error('编辑恢复记录无效，原记录已保留');
  if(value.format===2&&value.kind!=='command'&&!(value.kind==='intent'&&value.commands?.length))throw Error('编辑恢复版本与内容不匹配，原记录已保留');
  if(value.key!==undefined&&value.key!==`${value.kind==='intent'?'intent':'draft'}:${value.id}`)throw Error('编辑恢复索引无效，原记录已保留');
  if(value.kind==='intent'){
    const payload=librarySavePayload(value.payload);
    if(value.id!==payload.requestId||typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint))throw Error('保存恢复内容无法核对，原记录已保留');
    if(value.commands!==undefined&&(!Array.isArray(value.commands)||value.commands.length>64||value.commands.some(item=>!object(item)||!uuid.test(item.id)||!uuid.test(item.version))||new Set(value.commands.map(item=>item.id)).size!==value.commands.length))throw Error('待完成操作关联无效');
    return {...value,payload};
  }
  if(!['note','form','settings','manager','fields','command'].includes(value.kind)||typeof value.version!=='string'||!uuid.test(value.version)||!object(value.value)||typeof value.target!=='string'||value.target.length>100||typeof value.label!=='string'||value.label.length>200||new TextEncoder().encode(JSON.stringify(value)).length>(value.kind==='command'?256*1024:EDIT_RECOVERY_LIMITS.draftBytes))throw Error('编辑草稿无效或过大，原记录已保留');
  value=structuredClone(value);const draft=value.value;
  if(value.kind==='command'){
    if(value.format!==2)throw Error('待完成操作格式无效');
    draft.command=libraryCommand(draft.command);
    if(draft.binding&&(!object(draft.binding)||!uuid.test(draft.binding.requestId)||typeof draft.binding.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(draft.binding.fingerprint)||!Number.isSafeInteger(draft.binding.revision)||draft.binding.revision<0))throw Error('待完成操作的保存关联无效');
  }
  if(value.kind==='note'&&(typeof draft.value!=='string'||draft.value.length>4000))throw Error('笔记草稿无效，原记录已保留');
  if(value.kind==='manager'&&(!['list','series'].includes(draft.kind)||typeof draft.id!=='string'||value.target!==`${draft.kind}:${draft.id}`||typeof draft.value!=='string'||draft.value.length>40))throw Error('名称草稿无效，原记录已保留');
  const fields=['title','type','year','season','region','total','progress','status','tags','aliases','customCover','lists','seriesId','originalTitle','note','description'];
  if(value.kind==='form'&&(draft.id!==value.target||!object(draft.values)||Object.values(draft.values).some(item=>typeof item!=='string')||!Array.isArray(draft.lists)||draft.lists.some(item=>typeof item!=='string')||!Array.isArray(draft.changedFields)||draft.changedFields.some(item=>!fields.includes(item))))throw Error('作品编辑草稿无效，原记录已保留');
  if(value.kind==='fields'&&(!object(draft.patch)||Object.keys(draft.patch).some(key=>!['progress','status','rating','lists'].includes(key))))throw Error('作品调整草稿无效，原记录已保留');
  if(value.kind==='fields'){
    const patch=draft.patch;
    if(draft.action!==undefined&&!['progress','status','rating','lists','fields'].includes(draft.action))throw Error('作品调整类型无效，原记录已保留');
    if(('progress' in patch&&(!Number.isInteger(patch.progress)||patch.progress<0||patch.progress>9999))||('rating' in patch&&(!Number.isInteger(patch.rating)||patch.rating<0||patch.rating>5))||('status' in patch&&!['watching','planned','completed','paused'].includes(patch.status))||('lists' in patch&&(!Array.isArray(patch.lists)||patch.lists.some(item=>typeof item!=='string'||item.length>60))))throw Error('作品调整草稿数值无效，原记录已保留');
  }
  if(value.kind==='settings'&&Object.keys(draft).some(key=>!['theme','mode','accent','columns','rows','time','timeline','display','view','sort','sourceEnabled'].includes(key)))throw Error('设置草稿无效，原记录已保留');
  return structuredClone(value);
}
export function applyRecoveredFields(previous,{patch,action}){
  const next={...previous,...patch,updatedAt:new Date().toISOString()};
  if(action==='progress'){
    next.progress=Math.max(0,Math.min(previous.total||9999,Number(patch.progress)||0));
    next.status=previous.total&&next.progress===previous.total?'completed':['completed','planned'].includes(previous.status)?'watching':previous.status;
  }else if(Object.hasOwn(patch,'status')&&next.status==='completed'&&next.total)next.progress=next.total;
  return entry(next);
}

// Browser-local recovery is separate from the portable archive. Transactions
// resolve on completion, not on the put request's earlier success event.
export function createEditRecovery({indexedDB=globalThis.indexedDB,name='fandu-edit-recovery-v1'}={}){
  let database=null,opening=null;
  async function open(){
    if(database)return database;
    if(!opening)opening=new Promise((resolve,reject)=>{
      if(!indexedDB)return reject(Error('浏览器无法保留编辑恢复记录，本次尚未提交'));
      const request=indexedDB.open(name,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'key'});
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('恢复记录正在被旧窗口占用，请关闭旧窗口后重试'));
      request.onsuccess=()=>{database=request.result;database.onversionchange=()=>{database.close();database=null;opening=null;};resolve(database);};
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function transaction(mode,update,validate=true){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('records',mode,{durability:'strict'}),store=tx.objectStore('records');let result,cause;
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(cause||tx.error||Error('恢复记录未能写入，当前输入仍保留'));
      tx.onerror=()=>{};
      const request=store.getAll();
      request.onsuccess=()=>{try{
        let records=request.result;
        if(validate){try{records=records.map(recoveryRecord);}catch(error){error.code ||= 'FANDU_EDIT_RECOVERY_INVALID';throw error;}}
        result=update(records,store);
      }catch(error){cause=error;tx.abort();}};
    });
  }
  const key=value=>`${value.kind==='intent'?'intent':'draft'}:${value.id}`;
  const check=records=>{
    if(records.filter(item=>item.kind==='intent').length>EDIT_RECOVERY_LIMITS.intents||records.filter(item=>item.kind!=='intent').length>EDIT_RECOVERY_LIMITS.drafts||new TextEncoder().encode(JSON.stringify(records)).length>EDIT_RECOVERY_LIMITS.bytes)throw Error('未完成编辑已达恢复容量上限，请先处理现有记录');
  };
  return {
    async read(){const records=await transaction('readonly',records=>{check(records);return records;});for(const record of records)if(record.kind==='intent'&&await librarySaveFingerprint(record.payload)!==record.fingerprint)throw Object.assign(Error('保存恢复内容校验失败，原记录已保留'),{code:'FANDU_EDIT_RECOVERY_INVALID'});return records;},
    async prepare(payload,commands=[]){
      const value=recoveryRecord({format:commands.length?2:1,kind:'intent',id:payload.requestId,payload,fingerprint:await librarySaveFingerprint(payload),...(commands.length?{commands}:{}),updatedAt:new Date().toISOString()});
      return transaction('readwrite',(records,store)=>{
        const previous=records.find(item=>item.key===key(value));
        if(previous&&(previous.fingerprint!==value.fingerprint||JSON.stringify(previous.payload)!==JSON.stringify(value.payload)))throw Error('恢复编号对应不同内容，未覆盖原记录');
        if(!previous){
          const next=[...records];
          for(const ref of commands){
            const pending=records.find(item=>item.key===`draft:${ref.id}`);
            if(pending?.kind!=='command'||pending.version!==ref.version||pending.value.binding)throw Error('待完成操作已变化，未提交新请求');
            const linked={...pending,value:{...pending.value,binding:{requestId:payload.requestId,fingerprint:value.fingerprint,revision:payload.revision}}};next[next.findIndex(item=>item.key===pending.key)]=linked;store.put(linked);
          }
          const record={...value,key:key(value)};check([...next,record]);store.add(record);
        }
        return value;
      });
    },
    async writeDraft(value,previousVersion=null){
      const record={...recoveryRecord({...value,format:value.kind==='command'?2:1}),key:`draft:${value.id}`};
      return transaction('readwrite',(records,store)=>{
        const previous=records.find(item=>item.key===record.key);
        if((previous?.version||null)!==previousVersion)throw Error('编辑恢复记录已变化，当前输入仍保留');
        if(previous?.value?.binding)throw Error('请先核对同一次操作，未覆盖其保存关联');
        check([...records.filter(item=>item.key!==record.key),record]);store.put(record);return record;
      });
    },
    async forgetIntent(payload,outcome={state:'completed'}){return transaction('readwrite',(records,store)=>{
      const previous=records.find(item=>item.key===`intent:${payload.requestId}`),removed=[];
      if(previous&&JSON.stringify(previous.payload)!==JSON.stringify(librarySavePayload(payload)))throw Error('保存恢复内容已变化，未清除');
      for(const ref of previous?.commands||[]){
        const pending=records.find(item=>item.key===`draft:${ref.id}`);if(pending?.kind!=='command'||pending.version!==ref.version||pending.value.binding?.requestId!==payload.requestId)continue;
        if(outcome.state==='completed'){store.delete(pending.key);removed.push(pending.id);}else{const {binding,...value}=pending.value;store.put({...pending,value});}
      }
      store.delete(`intent:${payload.requestId}`);return removed;
    });},
    async forgetDraft(id,version){return transaction('readwrite',(records,store)=>{const previous=records.find(item=>item.key===`draft:${id}`);if(!previous)return true;if(previous.version!==version)return false;if(previous.value.binding&&records.some(item=>item.kind==='intent'&&item.id===previous.value.binding.requestId))throw Error('请先核对这次操作，再决定是否放弃');store.delete(previous.key);return true;});},
    async inspect(){
      const records=await transaction('readonly',records=>records,false),broken=[],newer=[];
      for(const value of records){try{const valid=recoveryRecord(value);if(valid.kind==='intent'&&await librarySaveFingerprint(valid.payload)!==valid.fingerprint)throw Error('保存内容校验失败');}catch(error){(error.code==='FANDU_EDIT_RECOVERY_TOO_NEW'?newer:broken).push({key:value.key,label:typeof value.label==='string'?value.label:'未完成保存',error:error.message});}}
      const bytes=new TextEncoder().encode(JSON.stringify(records)),digest=await crypto.subtle.digest('SHA-256',bytes),token=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
      return {records,broken,newer,token,bytes:bytes.length};
    },
    async discardBroken(snapshot,{protectedKeys=[]}={}){
      const current=await this.inspect();if(current.token!==snapshot.token)throw Error('恢复记录已变化，请重新查看后确认');
      if(!current.broken.length)return 0;
      return transaction('readwrite',(records,store)=>{if(JSON.stringify(records)!==JSON.stringify(current.records))throw Error('恢复记录已变化，未放弃任何记录');const removed=current.broken.filter(item=>!protectedKeys.includes(item.key));for(const item of removed)store.delete(item.key);return removed.length;},false);
    },
    close(){database?.close();database=null;opening=null;}
  };
}
