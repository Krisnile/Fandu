export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_LISTS = 24;
export const MAX_MANAGED_TAGS = 100;
export const MAX_ENTRY_TAGS = 24;
export const MAX_SERIES = 100;
export const text = (v, n = 160) => typeof v === 'string' ? v.normalize('NFKC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n) : '';
const integer = (v, min, max, fallback) => Number.isInteger(v) && v >= min && v <= max ? v : fallback;
export function customImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const u = new URL(value.trim());
    // Public domain names only; the server also validates and pins DNS before connecting.
    const host = u.hostname;
    // One legacy public cover host used by the imported Manki archive serves
    // images on a fixed HTTPS port. Keep the exception narrow: exact host,
    // exact port, and the image-only path prefix; all other custom links keep
    // the normal no-port policy.
    const importedMankiCover = host === 'cdn.aqdstatic.com' && u.port === '966' && /^\/age\/[a-z0-9._%/-]+$/i.test(u.pathname);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || importedMankiCover) && !u.hash &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(host) &&
      !host.split('.').some(x => !x || x.length > 63 || x.startsWith('-') || x.endsWith('-')) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/i.test(host) ? u.href : '';
  } catch { return ''; }
}
export function preferences(value = {}) {
  const defaults = [
    { id:'library', label:'收藏', kind:'all', status:'' },
    { id:'watching', label:'在看', kind:'status', status:'watching' },
    { id:'planned', label:'想看', kind:'status', status:'planned' },
    { id:'completed', label:'看过', kind:'status', status:'completed' },
    { id:'paused', label:'搁置', kind:'status', status:'paused' }
  ];
  const rawLists = Array.isArray(value?.lists) ? value.lists.map((x, i) => ({
    id: text(x?.id, 60) || `list-${i}`,
    label: text(x?.label, 30) || `列表 ${i + 1}`,
    kind: ['all','status','custom'].includes(x?.kind) ? x.kind : 'custom',
    status: ['watching','planned','completed','paused'].includes(x?.status) ? x.status : ''
  })).slice(0, MAX_LISTS) : defaults;
  // Older local archives briefly wrote the two built-in status labels in reverse
  // order. Repair only that exact pair; user-renamed lists remain untouched.
  const watching = rawLists.find(x => x.id === 'watching' && x.kind === 'status' && x.status === 'watching');
  const planned = rawLists.find(x => x.id === 'planned' && x.kind === 'status' && x.status === 'planned');
  const repairedLists = watching?.label === '想看' && planned?.label === '在看'
    ? rawLists.map(x => x === watching ? {...x, label:'在看'} : x === planned ? {...x, label:'想看'} : x)
    : rawLists;
  const seenIds = new Set(), seenLabels = new Set();
  const lists = repairedLists.filter(x => !seenIds.has(x.id) && !seenLabels.has(x.label) && (seenIds.add(x.id), seenLabels.add(x.label), true));
  if (!lists.some(x => x.kind === 'all')) lists.unshift(defaults[0]);
  const tags = Array.isArray(value?.tags) ? [...new Set(value.tags.map(x => text(x, 40)).filter(Boolean))].slice(0, MAX_MANAGED_TAGS) : [];
  const rawSeries = Array.isArray(value?.series) ? value.series.map((x, i) => ({ id: text(x?.id, 60) || `series-${i}`, label: text(x?.label, 40) || `系列 ${i + 1}` })).slice(0, MAX_SERIES) : [];
  const seenSeriesIds = new Set(), seenSeriesLabels = new Set();
  const series = rawSeries.filter(x => {
    const labelKey = x.label.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
    if (seenSeriesIds.has(x.id) || seenSeriesLabels.has(labelKey)) return false;
    seenSeriesIds.add(x.id); seenSeriesLabels.add(labelKey); return true;
  });
  const display = value?.display && typeof value.display === 'object' ? value.display : {};
  const sourceEnabled = value?.sourceEnabled && typeof value.sourceEnabled === 'object' ? value.sourceEnabled : {};
  const sourceKeys = ['bangumi','tvmaze','kitsu','jikan','wikidata','wikipedia','ann','douban','imdb','anidb'];
  const enabledSources = Object.fromEntries(sourceKeys.map(key => [key, sourceEnabled[key] !== false]));
  return {
    // Six columns is the comfortable default on desktop. Ten is the hard
    // upper bound; the layout still clamps that value to the available card
    // width, so phones naturally show fewer columns.
    columns: value?.columns === 0 ? 0 : integer(value?.columns, 4, 10, 6), rows: integer(value?.rows, 0, 6, 0), lists, tags, series,
    theme: ['blue','violet','cyan','amber','graphite'].includes(value?.theme) ? value.theme : 'blue',
    mode: ['dark','light'].includes(value?.mode) ? value.mode : 'dark',
    accent: /^#[0-9a-f]{6}$/i.test(value?.accent || '') ? value.accent.toLowerCase() : '',
    time: ['none','date','relative'].includes(value?.time) ? value.time : 'none',
    // The visible timeline is deliberately about works, not local file
    // activity. Migrate old axis choices while keeping their archives valid.
    timeline: 'premiere',
    view: ['grid','list'].includes(value?.view) ? value.view : 'grid',
    // “最近收录／最近更新” were based on local timestamps and were not
    // useful for a catalogue. Keep old archives readable, but migrate both
    // legacy keys to the explicit premiere-based default.
    sort: ['created','updated'].includes(value?.sort) ? 'premiere' : (['premiere','title','rating','score','year'].includes(value?.sort) ? value.sort : 'premiere'),
    display: { year: display.year !== false, type: display.type !== false, rating: display.rating !== false, count: display.count !== false },
    // TMDB was removed because it requires a user-supplied token. Keep any
    // legacy value ignored so old settings continue to load safely.
    sourceEnabled: enabledSources
  };
}
export function pageLayout(count, settings, width, requestedPage = 1, focusedIndex = -1) {
  const listView = settings?.view === 'list', prefs = preferences(settings), gap = width < 600 ? 13 : 22;
  const capacity = Math.max(1, Math.floor((width + gap) / (118 + gap)));
  const auto = Math.max(1, Math.floor((width + gap) / (162 + gap)));
  const columns = listView ? 1 : Math.min(prefs.columns || auto, capacity);
  const pageSize = prefs.rows ? columns * prefs.rows : Math.max(1, count);
  const pages = Math.max(1, Math.ceil(count / pageSize));
  // When resizing changes page capacity, keep an actively focused work on
  // screen instead of dropping it out of the newly shortened page.
  const anchoredPage = Number.isInteger(focusedIndex)&&focusedIndex>=0&&focusedIndex<count
    ? Math.floor(focusedIndex/pageSize)+1 : requestedPage;
  const page = Math.max(1, Math.min(pages, anchoredPage));
  return { columns, pageSize, pages, page, start: (page - 1) * pageSize };
}
export function imageUrl(value) {
  try {
    const u = new URL(value);
    const rules = { 'lain.bgm.tv': /^\/(?:r\/\d+\/)?pic\//, 'image.tmdb.org': /^\/t\/p\//, 'static.tvmaze.com': /^\/uploads\/images\//, 'media.kitsu.io': /^\/anime\/poster_images\//, 'cdn.animenewsnetwork.com': /^\/encyclopedia\/images\// };
    const malImage = /^images\d*\.myanimelist\.net$/.test(u.hostname) && /^\/images\//.test(u.pathname);
    // Yuc's public seasonal catalogue hosts its posters on Bilibili's static
    // image CDN. Keep this allowlist narrow instead of accepting arbitrary
    // image hosts from a remote page.
    const yucImage = /^i\d+\.hdslb\.com$/.test(u.hostname) && /^\/bfs\//.test(u.pathname);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && (rules[u.hostname]?.test(u.pathname) || malImage || yucImage) && !u.search && !u.hash ? u.href : '';
  } catch { return ''; }
}
export function sourceUrl(id) {
  if (/^bangumi:\d+$/.test(id)) return `https://bgm.tv/subject/${id.split(':')[1]}`;
  if (/^tvmaze:\d+$/.test(id)) return `https://www.tvmaze.com/shows/${id.split(':')[1]}`;
  if (/^tmdb:(movie|tv):\d+$/.test(id)) return `https://www.themoviedb.org/${id.split(':').slice(1).join('/')}`;
  if (/^kitsu:\d+$/.test(id)) return `https://kitsu.io/anime/${id.split(':')[1]}`;
  if (/^jikan:\d+$/.test(id)) return `https://myanimelist.net/anime/${id.split(':')[1]}`;
  if (/^anilist:\d+$/.test(id)) return `https://anilist.co/anime/${id.split(':')[1]}`;
  return '';
}
// Manual imports may still point at a verified public episode or store page.
// Keep that link only when it is an HTTPS URL without credentials, query
// strings or fragments; otherwise fall back to the canonical source URL.
export function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const u = new URL(value.trim());
    const host = u.hostname;
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(host) &&
      !host.split('.').some(x => !x || x.length > 63 || x.startsWith('-') || x.endsWith('-')) &&
      !/(?:^|\.)?(?:localhost|local|internal|lan|home|test|invalid|onion)$/i.test(host) ? u.href : '';
  } catch { return ''; }
}
export function entry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !text(input.title)) throw new Error('每条记录必须有作品名称。');
  if (!['anime','tv','movie'].includes(input.type)) throw new Error('作品类型无效。');
  const total = integer(input.total, 1, 9999, null);
  const progress = Math.min(integer(input.progress, 0, 9999, 0), total || 9999);
  const id = text(input.id, 100);
  if (!id || !/^[\w:.-]+$/.test(id)) throw new Error('记录编号无效。');
  const date = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
  const list = (v) => Array.isArray(v) ? [...new Set(v.map(s => text(s, 160)).filter(Boolean))].slice(0, 24) : [];
  const sourceId = text(input.sourceId, 100);
  return { id, sourceId, sourceUrl: safeSourceUrl(input.sourceUrl) || sourceUrl(sourceId), source: sourceId.split(':')[0] || 'manual',
    title: text(input.title), originalTitle: text(input.originalTitle), aliases: list(input.aliases),
    type: input.type, format: text(input.format, 40), year: integer(input.year, 1888, 2100, null),
    season: ['冬','春','夏','秋'].includes(input.season) ? input.season : '',
    // Remote seasonal feeds can distinguish a newly premiered title from a
    // continuing show. Keep this marker only for catalog filtering; it does
    // not change a user's collection status or progress semantics.
    seasonNew: input.seasonNew === true,
    total, progress, status: ['watching','planned','completed','paused'].includes(input.status) ? input.status : 'planned',
    region: text(input.region, 30),
    studios: list(input.studios), airedAt: date(input.airedAt),
    broadcastDay: integer(input.broadcastDay, 1, 7, null),
    broadcastTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.broadcastTime || '') ? input.broadcastTime : '',
    broadcastLabel: text(input.broadcastLabel, 80),
    broadcastTimezone: text(input.broadcastTimezone, 50),
    rating: integer(input.rating, 0, 5, 0), score: typeof input.score === 'number' && input.score >= 0 && input.score <= 10 ? input.score : null,
    // `genres` are provider metadata (for example “奇幻” or “漫画改”).
    // `tags` are the user's own labels and must stay separate so source data
    // never leaks into the personal tag manager or poster chrome.
    genres: list(input.genres), tags: list(input.tags).slice(0, MAX_ENTRY_TAGS), lists: list(input.lists), seriesId: text(input.seriesId, 60), description: text(input.description, 1200), note: text(input.note, 4000),
    cover: imageUrl(input.cover), customCover: customImageUrl(input.customCover), statusText: text(input.statusText, 80), fetchedAt: date(input.fetchedAt),
    createdAt: date(input.createdAt), updatedAt: date(input.updatedAt) || new Date().toISOString(),
    palette: Array.isArray(input.palette) && input.palette.length === 2 && input.palette.every(c => /^#[0-9a-f]{6}$/i.test(c)) ? input.palette : ['#6f8580','#263e42']
  };
}
export function validateLibrary(items) {
  if (!Array.isArray(items) || items.length > MAX_ENTRIES) throw new Error(`最多保存 ${MAX_ENTRIES} 条记录。`);
  const result = items.map(entry);
  if (new Set(result.map(x => x.id)).size !== result.length) throw new Error('存在重复的记录编号。');
  const sources = result.map(x => x.sourceId).filter(Boolean);
  if (new Set(sources).size !== sources.length) throw new Error('同一个来源的作品已收录。');
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) throw new Error('档案超出 2 MB 上限，请缩短笔记或减少记录。');
  return result;
}
