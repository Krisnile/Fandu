const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const SEASON_MONTH = { '冬':0, '春':3, '夏':6, '秋':9 };
export function premiereStamp(item) {
  const exact = stamp(item?.airedAt);
  if (exact) return exact;
  if (Number.isInteger(item?.year)) return Date.UTC(item.year, SEASON_MONTH[item.season] ?? 0, 1);
  return 0;
}
export function premiereYear(item) {
  const exact = stamp(item?.airedAt);
  if (exact) return new Date(exact).getUTCFullYear();
  return Number.isInteger(item?.year) ? item.year : null;
}
export function premiereDetail(item) {
  const exact = stamp(item?.airedAt);
  if (exact) return new Date(exact).toLocaleDateString('zh-CN',{month:'long',day:'numeric',timeZone:'UTC'});
  if (Number.isInteger(item?.year) && item?.season) return `${item.season}季`;
  if (Number.isInteger(item?.year)) return `${item.year}年`;
  return '日期未知';
}
function timelineStamp(item, field) {
  return field === 'premiere' ? premiereStamp(item) : stamp(item?.[field]);
}
function timelineLabel(item, field) {
  const value = timelineStamp(item, field);
  if (!value) return '日期未知';
  if (field === 'premiere' && !item?.airedAt) {
    if (item.season) return `${item.year}年${item.season}季`;
    return `${item.year}年`;
  }
  return new Date(value).toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',timeZone:field === 'premiere' ? 'UTC' : undefined});
}
export function sortEntries(entries, order = 'premiere') {
  // Catalogue order describes the work itself. A local import or edit time
  // says nothing about where an entry belongs, so legacy keys are aliases for
  // the premiere-based order.
  const premiereOrder = (a,b) => premiereStamp(b) - premiereStamp(a) || a.title.localeCompare(b.title,'zh');
  const comparators = {
    // Legacy local-timestamp keys remain compatibility aliases. A caller
    // restoring an older preference must never reintroduce import/edit order
    // into the visible catalogue.
    created:premiereOrder,
    updated:premiereOrder,
    premiere:premiereOrder,
    title:(a,b)=>a.title.localeCompare(b.title,'zh'),
    rating:(a,b)=>b.rating-a.rating,
    score:(a,b)=>(b.score ?? -1)-(a.score ?? -1),
    year:(a,b)=>(b.year || 0)-(a.year || 0)
  };
  return entries.slice().sort(comparators[order] || comparators.premiere);
}
export function summarizeEntries(entries) {
  const rated = entries.filter(x=>x.rating > 0);
  return {total:entries.length, completed:entries.filter(x=>x.status==='completed').length,
    rated:rated.length, average:rated.length?rated.reduce((n,x)=>n+x.rating,0)/rated.length:null,
    types:Object.fromEntries(['anime','movie','tv'].map(key=>[key,entries.filter(x=>x.type===key).length])),
    statuses:Object.fromEntries(['watching','planned','completed','paused'].map(key=>[key,entries.filter(x=>x.status===key).length]))};
}
export function timelineGroups(entries, field = 'premiere') {
  // The catalogue timeline is about when a work premiered, not when it was
  // imported or edited locally. Keep the legacy timestamp axes available for
  // old callers, but make the useful catalogue axis the safe default.
  const key = ['createdAt','updatedAt','premiere'].includes(field) ? field : 'premiere';
  const groups = new Map();
  const sorted = entries.slice().sort((a,b) => timelineStamp(b,key) - timelineStamp(a,key) || a.title.localeCompare(b.title,'zh'));
  for(const item of sorted) {
    const label = timelineLabel(item,key);
    if(!groups.has(label))groups.set(label,[]);
    groups.get(label).push(item);
  }
  return [...groups];
}
