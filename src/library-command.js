import {entry,preferences,MAX_ENTRIES,MAX_LISTS,MAX_MANAGED_TAGS,MAX_SERIES} from './model.js';
import {normalizeText} from './search.js';
const types=new Set(['batch-list','create-list','delete-list','move-list','create-tag','delete-tag','create-series','delete-series','increment-progress','restart-entry','undo-restart','remove-entry','restore-entry']);
const id=value=>typeof value==='string'&&/^[\w:.-]{1,100}$/.test(value);
const label=(value,max=40)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.normalize('NFKC').trim().replace(/\s+/g,' ');
const existingLabel=value=>typeof value==='string'&&value.length>0&&value.length<=40;
const fail=message=>{throw Object.assign(Error(message),{status:409,retryable:false});};
export function libraryCommand(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!types.has(value.type))throw Error('待完成操作类型无效');
  const command=structuredClone(value),type=command.type;
  if(['create-list','create-series','delete-list','delete-series','increment-progress','restart-entry','undo-restart','remove-entry'].includes(type)&&!id(command.id))throw Error('待完成操作编号无效');
  if(['create-list','create-series','create-tag'].includes(type)&&!label(command.label,type==='create-list'?30:40))throw Error('待完成操作名称无效');
  if(['create-list','create-series'].includes(type)&&command.id.length>60)throw Error('待创建项目的编号过长');
  if(type==='delete-tag'&&!existingLabel(command.label))throw Error('待删除标签名称无效');
  if(['delete-list','delete-series'].includes(type)&&!existingLabel(command.expectedLabel))throw Error('待删除项目的确认名称无效');
  if(type==='batch-list'&&(!id(command.listId)||!Array.isArray(command.ids)||!command.ids.length||command.ids.length>MAX_ENTRIES||command.ids.some(value=>!id(value))||new Set(command.ids).size!==command.ids.length))throw Error('批量操作目标无效');
  if(type==='move-list'&&(!id(command.id)||!id(command.targetId)||command.id===command.targetId||typeof command.before!=='boolean'))throw Error('列表排序目标无效');
  if(type==='undo-restart'&&(!command.previous||!['watching','planned','completed','paused'].includes(command.previous.status)||!Number.isInteger(command.previous.progress)||command.previous.progress<0||command.previous.progress>9999))throw Error('撤销重看的原进度无效');
  if(type==='restore-entry')command.entry=entry(command.entry);
  return command;
}
// Commands describe the action, not a stale copy of the entire archive.
// Resolve their targets against the latest library when the queue executes.
export function applyLibraryCommand(library,value){
  const command=libraryCommand(value),settings=preferences(library.settings),now=new Date().toISOString();let entries=library.entries,effects={};
  const item=()=>{const found=entries.find(item=>item.id===command.id);if(!found)fail('作品已不存在，未重新创建');return found;};
  const patch=update=>{const previous=item();entries=entries.map(item=>item.id===previous.id?entry({...update(previous),updatedAt:now}):item);};
  if(command.type==='batch-list'){
    const target=settings.lists.find(item=>item.id===command.listId);if(!target||target.kind==='all')fail('目标列表已不存在，未调整作品');const ids=new Set(command.ids);
    if(!entries.some(item=>ids.has(item.id)))fail('已选作品已不存在，未重新创建');
    entries=entries.map(item=>!ids.has(item.id)?item:entry({...item,...(target.kind==='status'?{status:target.status,...(target.status==='completed'&&item.total?{progress:item.total}:{})}:{lists:[...new Set([...item.lists,target.id])]}),updatedAt:now}));
  }else if(['create-list','create-series'].includes(command.type)){
    const list=command.type==='create-list',field=list?'lists':'series',items=settings[field],maximum=list?MAX_LISTS:MAX_SERIES;
    if(items.some(item=>item.id===command.id))fail('项目已存在，未重复创建');
    if(items.some(item=>normalizeText(item.label)===normalizeText(command.label)))fail('名称已存在，未重复创建');
    if(items.length>=maximum)fail(`最多管理 ${maximum} 个${list?'列表':'系列'}`);
    settings[field]=[...items,{id:command.id,label:command.label,...(list?{kind:'custom',status:''}:{})}];
  }else if(['delete-list','delete-series'].includes(command.type)){
    const list=command.type==='delete-list',field=list?'lists':'series',target=settings[field].find(item=>item.id===command.id);
    if(!target)fail('项目已不存在，未再次删除');
    if(target.label!==command.expectedLabel||list&&target.kind==='all')fail('项目已变化，请在当前页面重新确认删除');
    settings[field]=settings[field].filter(item=>item.id!==target.id);
    entries=entries.map(item=>list?{...item,lists:item.lists.filter(id=>id!==target.id)}:item.seriesId===target.id?{...item,seriesId:''}:item);
  }else if(command.type==='create-tag'){
    if([...settings.tags,...entries.flatMap(item=>item.tags)].some(value=>normalizeText(value)===normalizeText(command.label)))fail('标签已存在，未重复创建');
    if(settings.tags.length>=MAX_MANAGED_TAGS)fail(`最多管理 ${MAX_MANAGED_TAGS} 个标签`);settings.tags=[...settings.tags,command.label];
  }else if(command.type==='delete-tag'){
    if(!settings.tags.includes(command.label)&&!entries.some(item=>item.tags.includes(command.label)))fail('标签已不存在，未再次删除');
    settings.tags=settings.tags.filter(value=>value!==command.label);entries=entries.map(item=>({...item,tags:item.tags.filter(value=>value!==command.label)}));
  }else if(command.type==='move-list'){
    const source=settings.lists.find(item=>item.id===command.id),target=settings.lists.find(item=>item.id===command.targetId);if(!source||!target||source.kind==='all'||target.kind==='all')fail('排序目标已变化，未移动列表');
    const ordered=settings.lists.filter(item=>item.id!==source.id),index=ordered.findIndex(item=>item.id===target.id);ordered.splice(index+(command.before?0:1),0,source);settings.lists=ordered;
  }else if(command.type==='increment-progress'){
    patch(previous=>{if(previous.status!=='watching'||!previous.total||previous.progress>=previous.total)fail('作品已不处于可递增状态');const progress=previous.progress+1;return {...previous,progress,status:progress===previous.total?'completed':'watching'};});
  }else if(command.type==='restart-entry'){
    effects.previous=entry(item());patch(previous=>({...previous,progress:0,status:'watching'}));
  }else if(command.type==='undo-restart'){
    patch(previous=>{if(previous.progress!==0||previous.status!=='watching')fail('进度已再次修改，未覆盖新的观看记录');return {...previous,status:command.previous.status,progress:command.previous.progress};});
  }else if(command.type==='remove-entry'){
    effects.removed=entry(item());entries=entries.filter(item=>item.id!==command.id);
  }else if(command.type==='restore-entry'){
    const restored=command.entry;if(entries.some(item=>item.id===restored.id||restored.sourceId&&item.sourceId===restored.sourceId))fail('作品已重新收录，未覆盖当前记录');
    const custom=new Set(settings.lists.filter(item=>item.kind==='custom').map(item=>item.id));entries=[...entries,entry({...restored,lists:restored.lists.filter(id=>custom.has(id)),seriesId:settings.series.some(item=>item.id===restored.seriesId)?restored.seriesId:'',updatedAt:now})];
  }
  return {entries,settings:preferences(settings),effects};
}
