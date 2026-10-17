import { text, imageUrl, customImageUrl, entry } from '../src/model.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { scoreEntry } from '../src/search.js';
import { customImageBody } from './custom-images.mjs';

export class LRU {
  constructor(limit = 100, maxBytes = 4 * 1024 * 1024) { this.limit = limit; this.maxBytes = maxBytes; this.map = new Map(); this.bytes = 0; }
  get(key) { const v = this.map.get(key); if (v) { this.map.delete(key); this.map.set(key, v); } return v?.value; }
  set(key, value) {
    const bytes = value.body?.length || Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    if (this.map.has(key)) { this.bytes -= this.map.get(key).bytes; this.map.delete(key); }
    this.map.set(key, { value, bytes }); this.bytes += bytes;
    while (this.map.size > this.limit || this.bytes > this.maxBytes) { const k = this.map.keys().next().value; this.bytes -= this.map.get(k).bytes; this.map.delete(k); }
  }
}

export async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error('响应过大'); }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw Error('响应过大'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

// Fixed public endpoints only; redirects must not turn the local server into a general proxy.
export async function remoteJson(url, options = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { ...options, redirect: 'error', headers: { 'User-Agent': 'Fandu/0.3 (local media tracker)', Accept: 'application/json', ...options.headers }, signal: AbortSignal.timeout(4500) });
      if (!r.ok) {
        await r.body?.cancel(); const e = Error(`HTTP ${r.status}`); e.status = r.status;
        if (r.status === 429) e.retryAfter = Math.min(120, Math.max(10, Number(r.headers.get('retry-after')) || 30));
        throw e;
      }
      return JSON.parse((await boundedBody(r, 2 * 1024 * 1024)).toString('utf8'));
    } catch (e) { last = e; if (e.status && e.status < 500) throw e; if (!attempt) await sleep(250); }
  }
  throw last;
}
export async function remoteText(url, options = {}) {
  // Most source probes and XML lookups should fail fast. The Yuc Reader
  // mirror is a fixed, HTTPS-only fallback for the seasonal catalogue and
  // can take a little longer while it renders the upstream HTML. Keep the
  // timeout explicit rather than letting callers pass arbitrary fetch
  // options through this bounded transport.
  const { timeoutMs = 4500, attempts = 2, ...fetchOptions } = options;
  const timeout = Number.isFinite(Number(timeoutMs)) ? Math.min(12_000, Math.max(1_000, Number(timeoutMs))) : 4_500;
  const retryCount = Number.isInteger(Number(attempts)) ? Math.min(2, Math.max(1, Number(attempts))) : 2;
  let last;
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      const r = await fetch(url, { ...fetchOptions, redirect: 'error', headers: { 'User-Agent': 'Fandu/0.3 (local media tracker)', Accept: 'application/xml,text/plain;q=0.9,*/*;q=0.5', ...fetchOptions.headers }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) { await r.body?.cancel(); const e = Error(`HTTP ${r.status}`); e.status = r.status; if (r.status === 429) e.retryAfter = Math.min(120, Math.max(10, Number(r.headers.get('retry-after')) || 30)); throw e; }
      return (await boundedBody(r, 2 * 1024 * 1024)).toString('utf8');
    } catch (e) { last = e; if (e.status && e.status < 500) throw e; if (attempt + 1 < retryCount) await sleep(250); }
  }
  throw last;
}
export async function remoteProbe(url) {
  const r = await fetch(url, { method:'GET', redirect:'error', headers:{'User-Agent':'Fandu/0.3 (local media tracker)', Accept:'text/html,application/json;q=0.9,*/*;q=0.5'}, signal:AbortSignal.timeout(4500) });
  if (!r.ok) { const e = Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  await boundedBody(r, 512 * 1024);
  return { ok:true, status:r.status };
}
const year = d => Number(String(d || '').slice(0,4)) || null;
const season = d => ['冬','春','夏','秋'][Math.floor((Number(String(d || '').slice(5,7)) - 1)/3)] || '';
const plain = v => text(String(v || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&'), 1200);
function base(id, raw) {
  return entry({ ...raw, id, sourceId: id, fetchedAt: new Date().toISOString(), progress: 0, status: 'planned' });
}
export function mapBangumi(i) {
  if (!Number.isSafeInteger(i?.id) || ![2,6].includes(i.type) || i.nsfw) return null;
  const infobox = Array.isArray(i.infobox) ? i.infobox : [];
  const aliases = infobox.filter(x => x.key === '别名').flatMap(x => Array.isArray(x.value) ? x.value.map(v => v.v) : [x.value]);
  return base(`bangumi:${i.id}`, { title: plain(i.name_cn || i.name), originalTitle: plain(i.name), aliases: aliases.map(plain),
    type: i.type === 2 ? 'anime' : i.platform === '电影' ? 'movie' : 'tv', format: typeof i.platform === 'string' ? i.platform : '',
    total: i.eps || i.total_episodes || null, year: year(i.date), season: season(i.date), airedAt: i.date,
    description: plain(i.summary), cover: imageUrl(i.images?.common || i.images?.medium), score: i.rating?.score,
    genres: (Array.isArray(i.tags) ? i.tags : []).slice(0,8).map(t => plain(t.name)) });
}
export function mapTvmaze(i) {
  if (!Number.isSafeInteger(i?.id)) return null;
  return base(`tvmaze:${i.id}`, { title: i.name, originalTitle: i.name, type: i.type === 'Animation' ? 'anime' : 'tv',
    year: year(i.premiered), season: season(i.premiered), airedAt: i.premiered, format: i.type, statusText: i.status,
    cover: imageUrl(i.image?.medium), genres: i.genres, description: plain(i.summary), score: i.rating?.average });
}
export function mapTmdb(i, kind = i.media_type) {
  if (!Number.isSafeInteger(i?.id) || !['movie','tv'].includes(kind)) return null;
  const date = kind === 'movie' ? i.release_date : i.first_air_date;
  return base(`tmdb:${kind}:${i.id}`, { title: i.title || i.name, originalTitle: i.original_title || i.original_name,
    type: kind, format: kind === 'movie' ? '电影' : '剧集', total: kind === 'movie' ? 1 : i.number_of_episodes || null,
    year: year(date), season: season(date), airedAt: date, score: i.vote_average, description: plain(i.overview),
    cover: i.poster_path ? imageUrl(`https://image.tmdb.org/t/p/w500${i.poster_path}`) : '', genres: i.genres?.map(x => x.name), statusText: i.status });
}

export function mapKitsu(i) {
  const id = Number(i?.id), a = i?.attributes || i;
  if (!Number.isSafeInteger(id) || !a || typeof a !== 'object') return null;
  const titles = a.titles && typeof a.titles === 'object' ? Object.values(a.titles) : [];
  // Kitsu sometimes includes Chinese localizations alongside its canonical
  // romanized title. Prefer those for the user-facing title while retaining
  // the canonical and Japanese forms as aliases/originalTitle, which makes
  // the remote seasonal catalogue much closer to Chinese release lists.
  const localized = [a.titles?.zh_cn, a.titles?.zh_tw].find(x => typeof x === 'string' && x.trim());
  const title = localized || a.canonicalTitle || titles.find(x => typeof x === 'string' && x.trim()) || '';
  if (!title) return null;
  const format = text(a.showType || a.subtype || '');
  const names = [a.canonicalTitle, ...titles, ...(Array.isArray(a.abbreviatedTitles) ? a.abbreviatedTitles : [])]
    .filter(x => typeof x === 'string' && x.trim() && x.trim() !== title).map(x => x.trim());
  const cover = a.coverImage?.large || a.coverImage?.original || a.coverImage?.small || '';
  return base(`kitsu:${id}`, { title, originalTitle: titles.find(x => x === a.titles?.ja_jp) || '', aliases: [...new Set(names)].slice(0,24),
    type: format.toLowerCase() === 'movie' ? 'movie' : 'anime', format, total: format.toLowerCase() === 'movie' ? 1 : a.episodeCount || null,
    year: year(a.startDate), season: season(a.startDate), airedAt: a.startDate, statusText: a.status, description: plain(a.synopsis || a.description),
    cover: imageUrl(cover), score: Number.isFinite(Number(a.averageRating)) ? Number(a.averageRating) / 10 : null,
    genres: Array.isArray(a.genres) ? a.genres.slice(0,8).map(x => typeof x === 'string' ? x : x?.name).filter(Boolean) : [] });
}
export function mapJikan(i) {
  const id = Number(i?.mal_id);
  if (!Number.isSafeInteger(id) || !text(i?.title || i?.titles?.english || i?.titles?.japanese)) return null;
  const title = text(i.title || i.titles?.english || i.titles?.japanese);
  const kind = String(i.type || '').toLowerCase() === 'movie' ? 'movie' : 'anime';
  return base(`jikan:${id}`, { title, originalTitle: text(i.title_japanese || i.titles?.japanese), aliases: [i.title_english, ...(Array.isArray(i.titles) ? i.titles.map(x=>x.title) : []), i.titles?.english, i.titles?.synonyms, ...(i.title_synonyms || [])].flat().filter(Boolean),
    type: kind, format: text(i.type), total: kind === 'movie' ? 1 : i.episodes || null, year: year(i.aired?.from), season: season(i.aired?.from), statusText: i.status,
    airedAt:i.aired?.from, studios:(i.studios || []).map(x=>x.name),
    broadcastDay:({Mondays:1,Tuesdays:2,Wednesdays:3,Thursdays:4,Fridays:5,Saturdays:6,Sundays:7})[i.broadcast?.day],
    broadcastTime:i.broadcast?.time, broadcastLabel:text(i.broadcast?.string, 80), broadcastTimezone:i.broadcast?.timezone,
    description: plain(i.synopsis), cover: imageUrl(i.images?.jpg?.large_image_url || i.images?.jpg?.image_url || i.images?.webp?.large_image_url), score: Number.isFinite(Number(i.score)) ? Number(i.score) : null,
    genres: [...(i.genres || []), ...(i.themes || [])].slice(0,8).map(x => typeof x === 'string' ? x : x?.name).filter(Boolean) });
}
const stableId = value => [...String(value || '')].reduce((hash, char) => (hash * 33 + char.codePointAt(0)) >>> 0, 5381).toString(36);

const YUC_SEASON_MONTH = Object.freeze({ 冬:'01', 春:'04', 夏:'07', 秋:'10' });
const YUC_WEEKDAY = Object.freeze({ 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 日:7 });
const yucPage = (yearValue, seasonValue) => YUC_SEASON_MONTH[seasonValue] ? `https://yuc.wiki/${yearValue}${YUC_SEASON_MONTH[seasonValue]}/` : '';
// HTTPS transport fallback for the fixed Yuc page only.  The Reader endpoint
// returns the upstream HTML over its own HTTPS connection, so we do not
// disable certificate verification or downgrade the local request to HTTP.
const yucReaderPage = (yearValue, seasonValue) => YUC_SEASON_MONTH[seasonValue] ? `https://r.jina.ai/http://yuc.wiki/${yearValue}${YUC_SEASON_MONTH[seasonValue]}/` : '';
const isYucCertificateError = error => error?.cause?.code === 'CERT_HAS_EXPIRED' || /certificate (?:has )?expired|CERT_HAS_EXPIRED/i.test(String(error?.message || ''));
const decodeHtml = value => String(value || '')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
const htmlText = (value, limit = 240) => text(decodeHtml(String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' '), limit);
const yucKey = value => htmlText(value, 240).replace(/[\s\u3000]/g, '').replace(/[·・:：,，。.!！?？、\-—_/'"“”‘’()（）[\]【】]/g, '').toLowerCase();
const yucEpisodeCount = value => {
  const raw = htmlText(value, 120);
  const total = raw.match(/全\s*(\d+)\s*话/i)?.[1];
  if (total) return Number(total);
  const parts = [...raw.matchAll(/P\s*\d+\s*=\s*(\d+)\s*话/gi)].map(x => Number(x[1])).filter(Number.isInteger);
  return parts.length ? Math.max(...parts) : null;
};
const yucTime = value => {
  const raw = htmlText(value, 120), match = raw.match(/(?:^|\D)(\d{1,2}):([0-5]\d)/);
  if (!match) return { time:'', label:'' };
  const hour = Number(match[1]), minute = match[2];
  // Yuc uses 24:xx/25:xx for late-night Japanese broadcasts. Preserve that
  // notation in a display-only label while keeping the normalized field valid.
  return { time: hour < 24 ? `${String(hour).padStart(2,'0')}:${minute}` : '', label:`${match[1]}:${minute}` };
};
const yucDate = (value, yearValue, seasonValue = '') => {
  const match = htmlText(value, 160).match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!match) return null;
  const month = Number(match[1]), day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // A winter page can list a late-December preview from the previous year;
  // keep that date on the correct side of the season boundary.
  const dateYear = seasonValue === '冬' && month >= 10 ? Number(yearValue) - 1 : Number(yearValue);
  return new Date(Date.UTC(dateYear, month - 1, day)).toISOString();
};
const yucTitleFrom = block => htmlText(block.match(/<p\s+class="title_cn[^\"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1], 160);

// Parse the small, public schedule cards from yuc.wiki. The parser only
// accepts the page structure we expect and maps it into normal Fandu entries;
// a changed or empty page is treated as a source failure and never becomes a
// local fallback. This keeps the upstream catalogue transparent and bounded.
export function mapYucSeason(html, yearValue, seasonValue, pageUrl = yucPage(yearValue, seasonValue)) {
  const yearNumber = Number(yearValue);
  if (!Number.isInteger(yearNumber) || !YUC_SEASON_MONTH[seasonValue] || typeof html !== 'string') return [];
  const detailByTitle = new Map();
  const detailRe = /<!--#([ABC])\d+-->([\s\S]*?)(?=<!--#[ABC]\d+-->|$)/g;
  for (const match of html.matchAll(detailRe)) {
    const block = match[2], title = yucTitleFrom(block);
    if (!title) continue;
    const key = yucKey(title);
    const originalTitle = htmlText(block.match(/<p\s+class="title_jp[^\"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1], 180);
    const format = htmlText(block.match(/<td\s+class="type_[abc]_r"[^>]*>([\s\S]*?)<\/td>/i)?.[1], 40) || '电视动画';
    const genres = htmlText(block.match(/<td\s+class="type_tag[^\"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1], 180)
      .split(/[\/／]/).map(x => x.trim()).filter(Boolean).slice(0, 8);
    const studio = htmlText(block.match(/动画制作：([\s\S]*?)(?:<br\s*\/?>|<\/td>)/i)?.[1], 100);
    const broadcastRaw = htmlText(block.match(/<p\s+class="broadcast_r"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '', 160);
    const broadcastTiming = yucTime(broadcastRaw);
    const broadcastDay = YUC_WEEKDAY[broadcastRaw.match(/周([一二三四五六日])/u)?.[1]] || null;
    const official = [...block.matchAll(/<a\s+href="(https:\/\/[^"']+)"/gi)].map(x => x[1]).find(x => !/bilibili\.com|acg\.gamer\.com|crunchyroll\.com|netflix\.com|amazon\./i.test(x));
    const detailCover = imageUrl(block.match(/data-src="(https:\/\/i\d+\.hdslb\.com\/bfs\/[^"]+)"/i)?.[1] || '');
    detailByTitle.set(key, { title, originalTitle, format, genres, studios: studio ? [studio] : [], cover:detailCover,
      airedAt:yucDate(broadcastRaw, yearNumber, seasonValue), broadcastDay, broadcastTime:broadcastTiming.time, broadcastLabel:broadcastTiming.label || broadcastRaw,
      sourceUrl: official || pageUrl });
  }

  const results = [], seen = new Set(), matchedDetailKeys = new Set();
  const findDetail = key => {
    const exact = detailByTitle.get(key);
    if (exact) return [key, exact];
    // Yuc's weekly card often shortens a title (for example “地狱模式 第2期”
    // versus the full novel subtitle). Match only a shared leading segment so
    // unrelated works are never pulled into the same record.
    for (const [candidateKey, candidate] of detailByTitle) {
      const prefixLength = Math.min(8, Math.max(4, Math.floor(Math.min(key.length, candidateKey.length) * 0.6)));
      if (key.slice(0, prefixLength) === candidateKey.slice(0, prefixLength)) return [candidateKey, candidate];
    }
    return ['', {}];
  };
  const titleRe = /<td[^>]*class="date_title_[^\"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(titleRe)) {
    const title = htmlText(match[1], 160), key = yucKey(title);
    if (!title || !key || seen.has(key)) continue;
    const cardStart = html.lastIndexOf('<div class="div_date', match.index);
    if (cardStart < 0) continue;
    const tableEnd = html.indexOf('</table>', match.index);
    const card = html.slice(cardStart, tableEnd >= match.index ? tableEnd + 8 : match.index + 4000);
    const [detailKey, detail] = findDetail(key);
    if (detailKey) matchedDetailKeys.add(detailKey);
    const cover = card.match(/data-src="(https:\/\/i\d+\.hdslb\.com\/bfs\/[^"]+)"/i)?.[1] || '';
    const scheduleRaw = htmlText(card.match(/<p\s+class="(?:imgtext4|pmfs|pmfs2)"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '', 160);
    const episodeRaw = htmlText(card.match(/<p\s+class="(?:imgep|pmex|paomian)"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '', 80);
    const timing = yucTime(scheduleRaw), date = yucDate(scheduleRaw, yearNumber, seasonValue);
    const weekdayMatch = html.slice(0, cardStart).match(/<!--周([一二三四五六日])-->/g)?.pop()?.match(/周([一二三四五六日])/);
    const day = weekdayMatch ? YUC_WEEKDAY[weekdayMatch[1]] : null;
    const area = htmlText(card.match(/<p\s+class="area"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '', 30);
    const id = `yuc:${yearNumber}${YUC_SEASON_MONTH[seasonValue]}:${stableId(key)}`;
    try {
      const mapped = base(id, { ...detail, title: detail.title || title, originalTitle: detail.originalTitle || '', type:'anime', format:detail.format || '电视动画', total:yucEpisodeCount(episodeRaw), year:yearNumber, season:seasonValue, seasonNew:Boolean(detail.title), airedAt:date || detail.airedAt,
        broadcastDay:day || detail.broadcastDay || null, broadcastTime:timing.time || detail.broadcastTime, broadcastLabel:timing.label || scheduleRaw || detail.broadcastLabel, broadcastTimezone:'Asia/Tokyo', cover:imageUrl(cover) || detail.cover || '', region:'', description:area ? `播出地区：${area}` : '', score:null, genres:detail.genres || [], studios:detail.studios || [], sourceUrl:detail.sourceUrl || pageUrl });
      mapped.seasonNew = Boolean(detail.title);
      results.push(mapped);
      seen.add(key);
    } catch { /* Skip malformed upstream cards while retaining valid entries. */ }
  }
  // A title can exist in Yuc's introduction list before it receives a weekly
  // slot. Add those announced works as new seasonal entries so search preview
  // remains complete while the tool page still represents the whole index.
  if (results.length && matchedDetailKeys.size < detailByTitle.size) {
    for (const [key, detail] of detailByTitle) {
      if (matchedDetailKeys.has(key)) continue;
      const id = `yuc:${yearNumber}${YUC_SEASON_MONTH[seasonValue]}:${stableId(key)}`;
      try {
        const mapped = base(id, { ...detail, type:'anime', format:detail.format || '电视动画', total:null, year:yearNumber, season:seasonValue, seasonNew:true,
          broadcastTimezone:'Asia/Tokyo', region:'', description:'', score:null, sourceUrl:detail.sourceUrl || pageUrl });
        mapped.seasonNew = true;
        results.push(mapped);
      } catch { /* Keep malformed announced records out of the result. */ }
    }
  }
  // Future quarter pages are often published before the weekly schedule. In
  // that shape yuc still has a complete A/B/C introduction list; expose those
  // records instead of falling through to a smaller, unrelated JSON result.
  if (!results.length) {
    for (const [key, detail] of detailByTitle) {
      const id = `yuc:${yearNumber}${YUC_SEASON_MONTH[seasonValue]}:${stableId(key)}`;
      try {
        const mapped = base(id, { ...detail, type:'anime', format:detail.format || '电视动画', total:null, year:yearNumber, season:seasonValue, seasonNew:true,
          broadcastTimezone:'Asia/Tokyo', region:'', description:'', score:null, sourceUrl:detail.sourceUrl || pageUrl });
        mapped.seasonNew = true;
        results.push(mapped);
      } catch { /* Keep malformed future-page records out of the result. */ }
    }
  }
  return results;
}

export function mapWikiSearch(i, type = 'all') {
  const title = text(i?.title);
  if (!title) return null;
  const kind = inferMediaType(i, type);
  const sourceUrl = `https://zh.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, '_')}`;
  return base(`wikipedia:${stableId(title)}`, { title, originalTitle: '', type: kind, format: '百科条目', total: kind === 'movie' ? 1 : null, description: plain(i?.snippet), cover: '', score: null, genres: [], sourceUrl });
}
export function mapWikidataSearch(i, type = 'all') {
  const id = text(i?.id), title = text(i?.label);
  if (!/^Q\d+$/.test(id) || !title) return null;
  const kind = inferMediaType(i, type);
  return base(`wikidata:${id}`, { title, originalTitle: '', type: kind, format: '结构化资料', total: kind === 'movie' ? 1 : null, description: plain(i?.description), cover: '', score: null, genres: [], sourceUrl:`https://www.wikidata.org/wiki/${id}` });
}
// Wikipedia and Wikidata are broad knowledge bases rather than media
// catalogues. A short query such as “海” otherwise returns oceans, people and
// countries which are technically text matches but useless in a work search.
// Keep the filter deliberately lexical and conservative: it only gates these
// two generic providers, while Bangumi / Kitsu / Jikan / TVmaze retain their
// source-specific recall. The raw descriptions are used because the mapped
// entry intentionally keeps no provider-specific fields.
const MEDIA_SEARCH_HINTS = Object.freeze({
  anime: /动画|動漫|动漫|番剧|番組|anime|animated|animation|ova|ona|アニメ/i,
  movie: /电影|電影|影片|动画电影|動畫電影|短片|长片|長片|film|movie|cinema|feature film|short film|映画/i,
  tv: /电视剧|電視劇|电视节目|電視節目|剧集|劇集|电视动画|電視動畫|series|television|tv show|drama|sitcom|テレビドラマ/i
});
const NON_WORK_SEARCH_HINTS = /演员|演員|歌手|足球|政治人物|政治家|科学家|科學家|作家|记者|記者|主持人|企業|公司|国家|國家|城市|地區|地区|疾病|河流|湖泊|大学|大學|女王|国王|皇帝|actress|actor|singer|footballer|politician|scientist|writer|journalist|company|country|city|river|lake|disease|university|queen|king/i;
function inferMediaType(raw, requested = 'all') {
  if (requested === 'movie' || requested === 'tv' || requested === 'anime') return requested;
  const value = [raw?.title, raw?.label, raw?.snippet, raw?.description, raw?.display?.description?.value].filter(Boolean).join(' ');
  if (MEDIA_SEARCH_HINTS.movie.test(value)) return 'movie';
  if (MEDIA_SEARCH_HINTS.tv.test(value)) return 'tv';
  return 'anime';
}
function mediaSearchCandidate(provider, raw, mapped, type = 'all') {
  if (provider !== 'wikipedia' && provider !== 'wikidata') return true;
  const titleValue = [raw?.title, raw?.label, mapped?.title].filter(Boolean).join(' ');
  const descriptionValue = plain([raw?.snippet, raw?.description,
    raw?.display?.description?.value, mapped?.description].filter(Boolean).join(' '));
  const titleSignal = Object.values(MEDIA_SEARCH_HINTS).some(hint => hint.test(titleValue));
  // Only the lead of an encyclopedia result is considered. Mentions of a
  // movie deep in an actor's biography must not turn that biography into a
  // collectible work.
  const lead = descriptionValue.slice(0, 220);
  const leadSignal = Object.values(MEDIA_SEARCH_HINTS).some(hint => hint.test(lead));
  if (!titleSignal && !leadSignal) return false;
  if (!titleSignal && NON_WORK_SEARCH_HINTS.test(lead)) return false;
  const textValue = `${titleValue} ${lead}`;
  const kinds = type === 'all' ? Object.keys(MEDIA_SEARCH_HINTS) : [type];
  return kinds.some(kind => MEDIA_SEARCH_HINTS[kind]?.test(textValue));
}
function xmlValue(block, type) {
  const match = block.match(new RegExp(`<info[^>]*type=["']${type}["'][^>]*>([\\s\\S]*?)<\\/info>`, 'i'));
  return match ? plain(match[1].replace(/<[^>]*>/g, ' ')).replace(/&quot;/g, '"').replace(/&#39;/g, "'") : '';
}
export function mapAnnXml(xml) {
  const results = [];
  for (const match of String(xml || '').matchAll(/<anime\b[^>]*\bid=["'](\d+)["'][^>]*>([\s\S]*?)<\/anime>/gi)) {
    const block = match[2], title = xmlValue(block, 'Main title') || xmlValue(block, 'Official title');
    if (!title) continue;
    const typeValue = (match[0].match(/\btype=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
    const kind = typeValue.includes('movie') ? 'movie' : 'anime';
    results.push(base(`ann:${Number(match[1])}`, { title, originalTitle: '', type: kind, format: text(typeValue), total: kind === 'movie' ? 1 : null, description: xmlValue(block, 'Plot Summary'), cover: '', score: null, genres: [] }));
  }
  return results;
}
export const SOURCE_CATALOG = {
  bangumi: { healthUrl:'https://api.bgm.tv/v0/subjects/1', search:true },
  tvmaze: { healthUrl:'https://api.tvmaze.com/shows/1', search:true },
  kitsu: { healthUrl:'https://kitsu.io/api/edge/anime/1', search:true },
  jikan: { healthUrl:'https://api.jikan.moe/v4/anime/1', search:true },
  wikidata: { healthUrl:'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=anime&language=en&format=json&limit=1', search:true },
  wikipedia: { healthUrl:'https://zh.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json', search:true },
  ann: { healthUrl:'https://cdn.animenewsnetwork.com/encyclopedia/api.xml?title=1', search:true, text:true },
  yuc: { healthUrl:'https://yuc.wiki/', seasonal:true, text:true },
  douban: { healthUrl:'https://movie.douban.com/', site:true },
  imdb: { healthUrl:'https://www.imdb.com/', site:true },
  anidb: { healthUrl:'https://anidb.net/', site:true }
};

export class Sources {
  constructor({ request = remoteJson, requestText = remoteText, probe = remoteProbe } = {}) {
    this.request = request; this.requestText = requestText; this.probe = probe; this.cache = new LRU(); this.pending = new Map(); this.cooldowns = new Map();
    this.health = Object.fromEntries(Object.keys(SOURCE_CATALOG).map(provider => [provider,{ state:'untested' }]));
  }
  async search(provider, q, type = 'all') {
    if (!Object.hasOwn(this.health, provider)) throw Error('未知数据源');
    if (SOURCE_CATALOG[provider]?.site || SOURCE_CATALOG[provider]?.seasonal) return { results: [], state:'site_only' };
    const key = `${provider}:${type}:${q.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < 15 * 60_000) return { ...cached.value, state: 'cached' };
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      try {
        if ((this.cooldowns.get(provider) || 0) > Date.now()) throw Error('来源暂时不可用，稍后自动重试');
        let raw, results;
        if (provider === 'bangumi') {
          raw = await this.request('https://api.bgm.tv/v0/search/subjects?limit=12', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: q, sort: 'match', filter: { type: type === 'anime' ? [2] : type === 'all' ? [2,6] : [6] } }) });
          if (!Array.isArray(raw?.data)) throw Error('来源返回了未知格式');
          results = raw.data.map(mapBangumi).filter(Boolean);
        } else if (provider === 'tvmaze') {
          raw = await this.request(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
          if (!Array.isArray(raw)) throw Error('来源返回了未知格式');
          results = raw.slice(0,12).map(x => mapTvmaze(x.show)).filter(Boolean);
        } else if (provider === 'kitsu') {
          raw = await this.request(`https://kitsu.io/api/edge/anime?filter%5Btext%5D=${encodeURIComponent(q)}&page%5Blimit%5D=12`);
          if (!Array.isArray(raw?.data)) throw Error('来源返回了未知格式');
          results = raw.data.map(mapKitsu).filter(Boolean);
        } else if (provider === 'jikan') {
          raw = await this.request(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=12&sfw=true`);
          if (!Array.isArray(raw?.data)) throw Error('来源返回了未知格式');
          results = raw.data.map(mapJikan).filter(Boolean);
        } else if (provider === 'wikidata') {
          raw = await this.request(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=zh&uselang=zh&format=json&limit=12`);
          if (!Array.isArray(raw?.search)) throw Error('来源返回了未知格式');
          results = raw.search.map(x => {
            const mapped = mapWikidataSearch(x, type);
            return mapped && mediaSearchCandidate(provider, x, mapped, type) ? mapped : null;
          }).filter(Boolean);
        } else if (provider === 'wikipedia') {
          raw = await this.request(`https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&utf8=1&srlimit=12`);
          if (!Array.isArray(raw?.query?.search)) throw Error('来源返回了未知格式');
          results = raw.query.search.map(x => {
            const mapped = mapWikiSearch(x, type);
            return mapped && mediaSearchCandidate(provider, x, mapped, type) ? mapped : null;
          }).filter(Boolean);
        } else if (provider === 'ann') {
          raw = await this.requestText(`https://cdn.animenewsnetwork.com/encyclopedia/api.xml?title=~${encodeURIComponent(q)}`);
          results = mapAnnXml(raw);
        } else throw Error('未知数据源');
        results = results.filter(x => type === 'all' || x.type === type).sort((a,b) => scoreEntry(b,q)-scoreEntry(a,q));
        const value = { results, state: 'ok', fetchedAt: new Date().toISOString() };
        this.cache.set(key, { time: Date.now(), value }); this.health[provider] = { state: 'ok', checkedAt: value.fetchedAt };
        return value;
      } catch (e) {
        this.cooldowns.set(provider, Date.now() + (e.retryAfter || 10) * 1000);
        this.health[provider] = { state: 'unavailable', checkedAt: new Date().toISOString() };
        return cached && Date.now() - cached.time < 24 * 3600_000
          ? { ...cached.value, state: 'stale', message: '网络暂不可用，显示 24 小时内的暂存结果。' }
          : { results: [], state: 'unavailable', message: e.status === 401 ? '来源暂时拒绝请求，请稍后重试。' : e.status === 429 ? '来源限流，稍后重试。' : '暂时连接失败；可以重试、换来源或手动收录。' };
      }
    })();
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
  async detail(id) {
    if (/^bangumi:\d+$/.test(id)) return mapBangumi(await this.request(`https://api.bgm.tv/v0/subjects/${id.split(':')[1]}`));
    if (/^tvmaze:\d+$/.test(id)) return mapTvmaze(await this.request(`https://api.tvmaze.com/shows/${id.split(':')[1]}`));
    if (/^kitsu:\d+$/.test(id)) {
      const raw = await this.request(`https://kitsu.io/api/edge/anime/${id.split(':')[1]}`);
      const mapped = mapKitsu(raw?.data);
      if (mapped) return mapped;
    }
    if (/^jikan:\d+$/.test(id)) return mapJikan(await this.request(`https://api.jikan.moe/v4/anime/${id.split(':')[1]}`));
    throw Error('这个来源暂不支持刷新，请编辑条目或重新检索。');
  }
  async season(yearValue, seasonValue, pageValue = 1, preferredValue = 'auto') {
    const yearNumber = Number(yearValue), seasonMap = {冬:'winter',春:'spring',夏:'summer',秋:'fall'};
    const page = Number(pageValue);
    if (!Number.isInteger(yearNumber) || yearNumber < 1950 || yearNumber > 2100 || !Object.hasOwn(seasonMap,seasonValue) || !Number.isInteger(page) || page < 1 || page > 100) throw Error('季度参数无效');
    const preferred = ['auto','yuc','jikan','kitsu'].includes(preferredValue) ? preferredValue : 'auto';
    const key = `season:${yearNumber}:${seasonValue}:${page}:${preferred}`, cached = this.cache.get(key);
    if (cached && Date.now()-cached.time < 3600_000) return {...cached.value,state:'cached'};
    if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      const fetchYuc = async () => {
        if (page !== 1) throw Error('Yuc 季度页不提供分页');
        const pageUrl = yucPage(yearNumber, seasonValue);
        let html;
        try {
          html = await this.requestText(pageUrl, { headers: { Accept:'text/html,application/xhtml+xml;q=0.9' } });
        } catch (error) {
          // Yuc's certificate is currently in a rollover gap.  Only this
          // fixed public page may use the HTTPS Reader mirror, and its result
          // still goes through the strict Yuc parser below.  Other sources and
          // arbitrary URLs never receive this fallback.
          if (!isYucCertificateError(error)) throw error;
          // One bounded attempt keeps the Reader fallback inside the local
          // server's 15-second request budget; the direct Yuc request already
          // had its own short retry before reaching this branch.
          html = await this.requestText(yucReaderPage(yearNumber, seasonValue), { timeoutMs: 12_000, attempts: 1, headers: { Accept:'text/html,application/xhtml+xml;q=0.9', 'x-respond-with':'html' } });
        }
        const results = mapYucSeason(html, yearNumber, seasonValue, pageUrl);
        if (!results.length) throw Error('Yuc 返回了未知格式');
        return { results, hasNext:false, total:results.length, source:'yuc', sourceUrl:pageUrl };
      };
      const fetchJikan = async () => {
        const raw = await this.request(`https://api.jikan.moe/v4/seasons/${yearNumber}/${seasonMap[seasonValue]}?page=${page}&limit=24&sfw=true`);
        if (!Array.isArray(raw?.data)) throw Error('Jikan 返回了未知格式');
        return { results: raw.data.map(mapJikan).filter(Boolean), hasNext:raw.pagination?.has_next_page===true, total:Number(raw.pagination?.items?.total)||null, source:'jikan' };
      };
      const fetchKitsu = async () => {
        // Kitsu supports both season and year filters.  Keep the page size at
        // its documented maximum and use an offset so a failed Jikan request
        // does not turn this view into an unbounded download.
        const offset = (page - 1) * 20;
        const raw = await this.request(`https://kitsu.io/api/edge/anime?filter%5Bseason%5D=${seasonMap[seasonValue]}&filter%5Byear%5D=${yearNumber}&filter%5Bsubtype%5D=TV&page%5Blimit%5D=20&page%5Boffset%5D=${offset}&sort=-startDate`, { headers:{ Accept:'application/vnd.api+json' } });
        if (!Array.isArray(raw?.data)) throw Error('Kitsu 返回了未知格式');
        const total = Number(raw.meta?.count) || null;
        return { results: raw.data.map(mapKitsu).filter(Boolean), hasNext:Boolean(raw.links?.next) || Boolean(total && offset + raw.data.length < total), total, source:'kitsu' };
      };
      // Yuc is a Chinese, schedule-oriented seasonal index and is queried
      // first for the complete quarter view. Jikan / Kitsu remain deterministic
      // JSON fallbacks for seasons missing from the static index or when its
      // HTML shape changes. Every loader is still behind the same one-hour
      // page cache and bounded remote request wrapper.
      const loaders = preferred === 'yuc' ? [fetchYuc] : preferred === 'jikan' ? [fetchYuc, fetchJikan] : preferred === 'kitsu' ? [fetchYuc, fetchKitsu] : [fetchYuc, fetchJikan, fetchKitsu];
      let lastError;
      for (const load of loaders) {
        try {
          const result = await load();
          const value={ ...result, state:'ok', page, fetchedAt:new Date().toISOString() };
          this.cache.set(key,{time:Date.now(),value});
          if (Object.hasOwn(this.health, result.source)) this.health[result.source] = { state:'ok', checkedAt:value.fetchedAt };
          return value;
        } catch (error) {
          lastError = error;
          const failedSource = load === fetchJikan ? 'jikan' : 'kitsu';
          if (load !== fetchYuc) this.health[failedSource] = { state:'unavailable', checkedAt:new Date().toISOString() };
        }
      }
      if(cached && Date.now()-cached.time<86400_000)return {...cached.value,state:'stale'};
      throw lastError || Error('季度数据暂不可用');
    })();
    this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
  }
  async check(provider) {
    if (!Object.hasOwn(SOURCE_CATALOG, provider)) throw Error('未知数据源');
    const target = SOURCE_CATALOG[provider].healthUrl;
    try {
      if (SOURCE_CATALOG[provider].text) { const body = await this.requestText(target); if (!body) throw Error('来源返回为空'); }
      else await this.probe(target);
      return (this.health[provider] = { state:'ok', checkedAt:new Date().toISOString() });
    } catch (e) {
      this.health[provider] = { state:'unavailable', checkedAt:new Date().toISOString() };
      return this.health[provider];
    }
  }
  async checkAll() {
    await Promise.all(Object.keys(SOURCE_CATALOG).map(provider => this.check(provider)));
    return this.health;
  }
}

export class Images {
  constructor({ concurrency = 8, maxQueued = 64, queueTimeout = 15_000, request = fetch, customRequest = customImageBody, diskCache = null } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 64 || !Number.isInteger(queueTimeout) || queueTimeout < 1 || queueTimeout > 15_000) throw Error('图片队列配置无效');
    this.cache = new LRU(120, 16 * 1024 * 1024); this.pending = new Map(); this.active = 0;
    this.queue = []; this.concurrency = concurrency; this.maxQueued = maxQueued; this.queueTimeout = queueTimeout;
    this.request = request; this.customRequest = customRequest; this.diskCache = diskCache;
  }
  acquire() {
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= this.maxQueued) return Promise.reject(Error('图片队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(Error('图片等待超时，请重试'));
      }, this.queueTimeout);
      this.queue.push(waiter);
    });
  }
  release() {
    const waiter = this.queue.shift();
    // Transfer the occupied slot directly so newly arriving work cannot jump the queue.
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(); }
    else this.active--;
  }
  async load(url, custom = false) {
    if (!custom && !imageUrl(url)) throw Error('不支持的图片来源');
    if (custom && !customImageUrl(url)) throw Error('自定义封面必须是公开域名的 HTTPS 图片链接');
    const key = `${custom ? 'custom:' : 'source:'}${url}`;
    let cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < 3600_000) return cached;
    if (!cached && this.diskCache) {
      try { cached = await this.diskCache.get(key); } catch { cached = null; }
    }
    if (cached && Date.now() - cached.time < 3600_000) { this.cache.set(key, cached); return cached; }
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      let acquired = false;
      try {
        await this.acquire(); acquired = true;
        let body;
        if (custom && !imageUrl(url)) body = await this.customRequest(url);
        else {
          const r = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Fandu/0.3', Accept: 'image/webp,image/jpeg,image/png' } });
          if (!r.ok) { await r.body?.cancel(); throw Error('图片来源暂不可用'); }
          body = await boundedBody(r, 2 * 1024 * 1024);
        }
        const type = body.subarray(0,3).equals(Buffer.from([255,216,255])) ? 'image/jpeg' : body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : body.toString('ascii',0,4) === 'RIFF' && body.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : '';
        if (!type) throw Error('图片格式不受支持');
        const value = { body, type, time: Date.now() }; this.cache.set(key, value); this.diskCache?.set(key, value).catch(() => {}); return value;
      } catch (e) { if (cached) return cached; throw e; } finally { if (acquired) this.release(); }
    })();
    this.pending.set(key, task); try { return await task; } finally { this.pending.delete(key); }
  }
}
