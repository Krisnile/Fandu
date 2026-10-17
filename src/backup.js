import { validateLibrary, MAX_BYTES, preferences, sourceUrl } from './model.js';
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');
const DEFAULT_PALETTE = ['#6f8580','#263e42'];
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

// Export a sparse record: defaults and empty fields are reconstructed by the
// parser. This keeps JSON backups small without dropping any user data or
// embedding binary cover files.
export function compactEntry(value) {
  const x = validateLibrary([value])[0];
  const out = { id:x.id, title:x.title, type:x.type };
  const optional = {
    sourceId:x.sourceId, originalTitle:x.originalTitle, aliases:x.aliases, format:x.format,
    year:x.year, season:x.season, seasonNew:x.seasonNew, total:x.total, progress:x.progress, status:x.status,
    region:x.region, studios:x.studios, airedAt:x.airedAt, broadcastDay:x.broadcastDay,
    broadcastTime:x.broadcastTime, broadcastLabel:x.broadcastLabel, broadcastTimezone:x.broadcastTimezone, rating:x.rating,
    score:x.score, genres:x.genres, tags:x.tags, lists:x.lists, seriesId:x.seriesId, description:x.description,
    note:x.note, cover:x.cover, customCover:x.customCover, statusText:x.statusText,
    fetchedAt:x.fetchedAt, createdAt:x.createdAt, updatedAt:x.updatedAt, palette:x.palette
  };
  const defaults = {
    sourceId:'', originalTitle:'', aliases:[], format:'', year:null, season:'', seasonNew:false, total:null,
    progress:0, status:'planned', region:'', studios:[], airedAt:null, broadcastDay:null,
    broadcastTime:'', broadcastLabel:'', broadcastTimezone:'', rating:0, score:null, genres:[], tags:[], lists:[], seriesId:'',
    description:'', note:'', cover:'', customCover:'', statusText:'', fetchedAt:null,
    createdAt:null, updatedAt:null, palette:DEFAULT_PALETTE
  };
  for (const [key,current] of Object.entries(optional)) if (!same(current, defaults[key])) out[key] = current;
  // Canonical source links are reconstructed from sourceId. Preserve only
  // explicit links attached to manual/episode-level imports so sparse backups
  // remain compact while verified references survive migration.
  const canonical = sourceUrl(x.sourceId);
  if (x.sourceUrl && x.sourceUrl !== canonical) out.sourceUrl = x.sourceUrl;
  return out;
}

export function expandEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { sourceId:'', sourceUrl:'', originalTitle:'', aliases:[], format:'', year:null, season:'', seasonNew:false, total:null,
    progress:0, status:'planned', region:'', studios:[], airedAt:null, broadcastDay:null,
    broadcastTime:'', broadcastLabel:'', broadcastTimezone:'', rating:0, score:null, genres:[], tags:[], lists:[], seriesId:'',
    description:'', note:'', cover:'', customCover:'', statusText:'', fetchedAt:null,
    createdAt:null, updatedAt:null, palette:DEFAULT_PALETTE, ...value };
}
export async function createBackup(entries, settings = {}) {
  // New exports use the current product identifier. Keep the parser below
  // backward-compatible with legacy Yingjian files so existing data remains
  // importable after the rebrand.
  const payload = {app:'fandu',version:3,exportedAt:new Date().toISOString(),entries:validateLibrary(entries).map(compactEntry),settings:preferences(settings)};
  return {...payload,checksum:await digest(payload)};
}
export async function parseBackup(raw) {
  return (await parseBackupBundle(raw)).entries;
}
export async function parseBackupBundle(raw) {
  if(new TextEncoder().encode(raw).length>MAX_BYTES*2) throw Error('备份文件过大');
  const b=JSON.parse(raw);
  if(!['fandu','yingjian'].includes(b.app) || ![1,2,3].includes(b.version) || !b.checksum) throw Error('不是受支持的番渡备份');
  const {checksum,...payload}=b;
  if(checksum!==await digest(payload)) throw Error('备份校验失败，文件可能不完整');
  const entries = b.version === 3 ? (Array.isArray(b.entries) ? b.entries.map(expandEntry) : b.entries) : b.entries;
  return { entries:validateLibrary(entries), settings:b.version>=2 ? preferences(b.settings) : null };
}
export async function createTransferBundle(entries, settings, covers) {
  if (!covers || !['fandu-cover-cache','yingjian-cover-cache'].includes(covers.app) || covers.version !== 1 || !Array.isArray(covers.entries) || typeof covers.checksum !== 'string') throw Error('封面缓存包无效，不能生成迁移包');
  const library = await createBackup(entries, settings);
  const payload = { app:'fandu-transfer', version:1, exportedAt:new Date().toISOString(), library, covers };
  const bundle = {...payload,checksum:await digest(payload)};
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > MAX_TRANSFER_BYTES) throw Error('迁移包过大，请先清理无用封面');
  return bundle;
}
export async function parsePortableBundle(raw) {
  if (new TextEncoder().encode(raw).length > MAX_TRANSFER_BYTES) throw Error('导入文件过大');
  const value = JSON.parse(raw);
  if (value?.app !== 'fandu-transfer') return {...await parseBackupBundle(raw),covers:null,coverCount:0,coverBytes:0,kind:'backup'};
  if (value.version !== 1 || typeof value.checksum !== 'string' || !value.library || !value.covers) throw Error('不是受支持的番渡迁移包');
  const {checksum,...payload}=value;
  if (checksum !== await digest(payload)) throw Error('迁移包校验失败，文件可能不完整');
  const covers = value.covers;
  if (!['fandu-cover-cache','yingjian-cover-cache'].includes(covers.app) || covers.version !== 1 || typeof covers.checksum !== 'string' || !Array.isArray(covers.entries) || covers.entries.length > 1200) throw Error('迁移包中的封面缓存无效');
  const library = await parseBackupBundle(JSON.stringify(value.library));
  const coverBytes = covers.entries.reduce((sum,item) => sum + (Number.isSafeInteger(item?.bytes) && item.bytes > 0 ? item.bytes : 0),0);
  return {...library,covers,coverCount:covers.entries.length,coverBytes,kind:'transfer'};
}
export function mergeBackup(current, incoming) {
  const added=incoming.filter(x=>!current.some(v=>v.id===x.id || x.sourceId && v.sourceId===x.sourceId));
  const entries=validateLibrary([...current,...added]);
  return {entries,added:added.length,skipped:incoming.length-added.length};
}
