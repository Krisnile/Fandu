// Short-lived notices count only time during which they can be used.
// The DOM adapter controls visibility, focus and modal-operation blocking.
export function createNotices({change=()=>{},announce=()=>{},now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,limit=3,errorText=error=>error?.message||'操作未完成，请重试'}={}){
  const items=[],pauses=new Set();let sequence=0,focused=null,blocked=false,disposed=false;
  const stop=item=>{if(item.timer!==null){cancel(item.timer);item.timer=null;item.remaining=Math.max(0,item.remaining-(now()-item.started));}};
  const snapshot=()=>items.map(item=>({id:item.id,message:item.message,label:item.action?.label||'',retryLabel:item.action?.retryLabel||'',persistent:Boolean(item.action?.persistent),busy:item.busy,error:item.error,unavailable:item.unavailable,blocked:blocked&&!item.action?.allowWhileBlocked}));
  function sync(){
    if(disposed)return;
    for(const item of items){stop(item);if(!pauses.size&&!item.busy&&!item.action?.persistent){item.started=now();item.timer=schedule(()=>dismiss(item.id),item.remaining);}}
    change(snapshot());
  }
  function dismiss(id,force=false){const index=items.findIndex(item=>item.id===id);if(index<0||!force&&(items[index].busy||items[index].action?.persistent))return false;stop(items[index]);items.splice(index,1);sync();return true;}
  function add(message,action){
    if(disposed)return;
    const text=String(message??'').trim();if(!text)return;
    const existing=!action&&items.find(item=>!item.action&&item.message===text);
    if(existing){stop(existing);existing.remaining=5500;sync();return existing.id;}
    while(items.length>=limit){
      const candidates=items.filter(item=>!item.busy&&!item.action?.persistent&&item.id!==focused),old=candidates.find(item=>!item.action)||candidates[0];
      // Reserve one critical recovery row even if all ordinary actions are
      // awaiting the write it needs to unblock. Never hide that sole exit.
      if(!old){if(action?.persistent&&!items.some(item=>item.action?.persistent))break;return;}dismiss(old.id);
    }
    const item={id:`notice:${++sequence}`,message:text,action,remaining:action?12000:5500,timer:null,started:0,busy:false,error:'',unavailable:false};
    items.push(item);announce(text);sync();return item.id;
  }
  async function run(id){
    const item=items.find(item=>item.id===id);if(!item?.action||item.busy||item.unavailable||blocked&&!item.action.allowWhileBlocked)return false;
    stop(item);item.busy=true;item.error='';sync();
    try{if(await item.action.run()===false)throw Error('操作未完成，请重试');if(disposed)return false;item.busy=false;dismiss(id,true);return true;}
    catch(error){if(disposed||!items.includes(item))return false;item.busy=false;item.error=errorText(error);item.unavailable=error?.retryable===false;item.remaining=12000;announce(item.error);sync();return false;}
  }
  function pause(reason,value){if(value)pauses.add(reason);else pauses.delete(reason);sync();}
  return {add,run,dismiss,remove:id=>dismiss(id,true),snapshot,pause,focus(id){focused=id;pause('focus',Boolean(id));},block(value){blocked=Boolean(value);pause('blocked',blocked);},destroy(){disposed=true;for(const item of items)stop(item);items.length=0;change([]);}};
}
