import {validateLibrary,preferences} from './model.js';

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function librarySavePayload(value){
  if(!value||typeof value.requestId!=='string'||!idPattern.test(value.requestId)||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('保存请求编号或版本无效');
  if(!value.settings||typeof value.settings!=='object'||Array.isArray(value.settings))throw Error('保存请求缺少完整设置');
  if(!Array.isArray(value.entries)||[...value.entries].some(item=>!item||(item.createdAt!==null&&(typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))))||typeof item.updatedAt!=='string'||!Number.isFinite(Date.parse(item.updatedAt))))throw Error('保存请求包含无效作品日期');
  return {requestId:value.requestId,revision:value.revision,entries:validateLibrary(value.entries),settings:preferences(value.settings)};
}
export function librarySaveContent(payload){return JSON.stringify({revision:payload.revision,entries:payload.entries,settings:payload.settings});}
export async function librarySaveFingerprint(payload){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(librarySaveContent(librarySavePayload(payload))));
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}

// A receipt proves the exact immutable request completed. Current contents
// may already include later edits, so do not compare them with the old draft.
export async function resolveLibrarySave(payload,{send,confirm}){
  const fingerprint=await librarySaveFingerprint(payload);
  const completed=result=>{
    if(result?.state!=='completed'||result.requestId!==payload.requestId||result.fingerprint!==fingerprint||result.revision!==payload.revision+1||!Number.isSafeInteger(result.library?.revision)||result.library.revision<result.revision)return false;
    try{validateLibrary(result.library.entries);return Boolean(result.library.settings&&typeof result.library.settings==='object'&&!Array.isArray(result.library.settings));}catch{return false;}
  };
  let cause;
  try{const result=await send(payload);if(completed(result))return {state:'completed',result};cause=Error('保存响应无法核对');}catch(error){cause=error;}
  try{
    const result=await confirm(payload.requestId);
    if(completed(result))return {state:'completed',result};
    // A received server error plus a serialized read at the original version
    // proves no publication took place. A network abort alone cannot prove it:
    // its disconnected handler may still be waiting to write.
    if(result?.state==='unknown'&&result.requestId===payload.requestId&&Number.isInteger(cause?.status)&&!cause.migrationPending&&((cause.status>=400&&cause.status<500&&cause.status!==408)||(cause.status>=500&&cause.status<600&&result.currentRevision===payload.revision)))return {state:'rejected',error:cause};
  }catch{/* Keep the same payload while the result remains uncertain. */}
  return {state:'pending',error:cause};
}

// One unresolved write owns the shared application queue. Its caller remains
// pending, so normal success/failure continuations execute only after proof.
export function createSaveCoordinator({send,confirm,prepare=async()=>{},finish=async()=>{},state=()=>{}}){
  let active=null;
  const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  const publish=()=>state({unconfirmed:Boolean(active?.unconfirmed),checking:Boolean(active?.running),prepared:Boolean(active?.prepared),error:active?.error||null,requestId:active?.payload.requestId||null});
  function attempt(){
    if(!active)return Promise.resolve(null);if(active.running)return active.running;
    const job=active;
    job.running=(async()=>{
      let outcome;try{
        if(!job.prepared){await prepare(job.payload);job.prepared=true;}
        outcome=await resolveLibrarySave(job.payload,{send,confirm});
        if(outcome.state!=='pending')await finish(job.payload,outcome);
      }catch(error){outcome={state:'pending',error};}
      job.running=null;
      if(outcome.state==='pending'){job.unconfirmed=true;job.error=outcome.error;publish();}
      else {active=null;publish();job.resolve(outcome);}
      return outcome;
    })();
    publish();return job.running;
  }
  return {
    async save(value){
      if(active)throw Error('上一项保存仍待核对');
      const payload=freeze(structuredClone(librarySavePayload(value)));let resolve;const settled=new Promise(done=>resolve=done);
      active={payload,resolve,running:null,unconfirmed:false,error:null};void attempt();return settled;
    },
    retry:attempt,
    get unconfirmed(){return Boolean(active?.unconfirmed);},
    get checking(){return Boolean(active?.running);}
  };
}
