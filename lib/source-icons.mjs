import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// These are fixed, first-party icon locations. The app never accepts an icon
// URL from the browser, so this cache cannot become a general-purpose proxy.
export const SOURCE_ICON_URLS = {
  bangumi: 'https://bgm.tv/img/favicon.ico',
  tvmaze: 'https://static.tvmaze.com/images/favico/favicon.ico',
  kitsu: 'https://kitsu.io/favicon.ico',
  jikan: 'https://jikan.moe/favicon/favicon.ico?v=2',
  wikidata: 'https://www.wikidata.org/static/favicon/wikidata.ico',
  wikipedia: 'https://zh.wikipedia.org/static/favicon/wikipedia.ico',
  ann: 'https://www.animenewsnetwork.com/favicon.ico',
  yuc: 'https://yuc.wiki/images/32x32.png',
  douban: 'https://movie.douban.com/favicon.ico',
  // IMDb redirects its root favicon through a bot-check page; use the
  // first-party static asset so the cache can fetch it without following a
  // redirect or storing an HTML response.
  imdb: 'https://m.media-amazon.com/images/G/01/imdb/images-ANDW73HA/favicon_desktop_32x32._CB1582158068_.png',
  anidb: 'https://anidb.net/favicon.ico'
};

const MAX_BYTES = 512 * 1024;
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml']);
const MARKS = { bangumi:'B', tvmaze:'TV', kitsu:'K', jikan:'MAL', wikidata:'WD', wikipedia:'W', ann:'ANN', yuc:'YUC', douban:'豆', imdb:'IMDb', anidb:'A' };
const COLORS = { bangumi:'#e17597', tvmaze:'#377968', kitsu:'#7b68ee', jikan:'#e85d75', wikidata:'#3d5a9a', wikipedia:'#5c5f66', ann:'#ef7f34', yuc:'#5278d9', douban:'#3c9a5f', imdb:'#c99a00', anidb:'#3b82a4' };

const escXml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[char]));
export function fallbackSourceIcon(source) {
  const mark = escXml(MARKS[source] || '手'), color = COLORS[source] || '#52616b';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="38" text-anchor="middle" font-family="Arial,sans-serif" font-size="${mark.length > 2 ? 16 : 22}" font-weight="700" fill="white">${mark}</text></svg>`);
}

function detectType(buffer, header = '') {
  const type = String(header).split(';', 1)[0].trim().toLowerCase();
  if (ALLOWED_TYPES.has(type)) return type;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([255,216,255]))) return 'image/jpeg';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 4 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) return 'image/x-icon';
  if (/^\s*<svg(?:\s|>)/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 512)))) return 'image/svg+xml';
  return '';
}

const validEntry = value => value && typeof value === 'object' && typeof value.file === 'string' && typeof value.type === 'string' && Number.isFinite(value.updatedAt);

export class SourceIconCache {
  constructor(dir, { sources = SOURCE_ICON_URLS, request = fetch } = {}) {
    this.dir = dir; this.sources = sources; this.request = request; this.indexPath = join(dir, 'index.json');
    this.index = new Map(); this.pending = new Map(); this.ready = this.load();
  }
  async load() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf8'));
      for (const [source, value] of Object.entries(raw || {})) if (Object.hasOwn(this.sources, source) && validEntry(value)) this.index.set(source, value);
    } catch { /* first run or damaged index: start with an empty cache */ }
  }
  async persist() {
    const object = Object.fromEntries(this.index);
    const temp = join(this.dir, `.index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(object), { mode: 0o600 });
      await rename(temp, this.indexPath);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async read(source) {
    await this.ready;
    const item = this.index.get(source);
    if (!item) return null;
    try {
      const body = await readFile(join(this.dir, item.file));
      if (body.length > MAX_BYTES) return null;
      const age = Date.now() - item.updatedAt;
    if (item.sourceUrl !== this.sources[source]) return null;
    if (item.status === 'fallback' ? Date.now() < (item.retryAt || 0) : age < FRESH_MS) return { body, type: item.type, cached: true, fallback: item.status === 'fallback' };
    } catch { /* missing/corrupt files are replaced on the next warm */ }
    return null;
  }
  warm(source) {
    if (!Object.hasOwn(this.sources, source)) return Promise.resolve(null);
    if (this.pending.has(source)) return this.pending.get(source);
    const task = (async () => {
      await this.ready;
      const current = this.index.get(source);
      if (current?.sourceUrl === this.sources[source] && current?.status === 'ok' && Date.now() - current.updatedAt < FRESH_MS) return this.read(source);
      if (current?.sourceUrl === this.sources[source] && current?.status === 'fallback' && Date.now() < (current.retryAt || 0)) return this.read(source);
      try {
        const response = await this.request(this.sources[source], { redirect: 'error', headers: { 'User-Agent': 'Fandu/0.3 (local media tracker)', Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/x-icon,image/*;q=0.8' }, signal: AbortSignal.timeout(4500) });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('图标响应过大');
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length === 0 || body.length > MAX_BYTES) throw Error('图标响应无效');
        const type = detectType(body, response.headers.get('content-type'));
        if (!type) throw Error('不支持的图标格式');
        if (type === 'image/svg+xml' && /<\s*(?:script|iframe)\b|\bon[a-z]+\s*=|javascript:|https?:\/\//i.test(body.toString('utf8'))) throw Error('图标 SVG 含有不安全内容');
        const hash = createHash('sha256').update(`${source}:`).update(body).digest('hex').slice(0, 24);
        const ext = type === 'image/svg+xml' ? 'svg' : type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : type === 'image/gif' ? 'gif' : 'ico';
        const file = `${hash}.${ext}`;
        await writeFile(join(this.dir, file), body, { mode: 0o600 });
        const previous = this.index.get(source);
        this.index.set(source, { file, type, bytes: body.length, updatedAt: Date.now(), status: 'ok', sourceUrl: this.sources[source] });
        if (previous?.file && previous.file !== file) await unlink(join(this.dir, previous.file)).catch(() => {});
        await this.persist();
        return { body, type, cached: false, fallback: false };
      } catch {
        const body = fallbackSourceIcon(source), file = `${source}-fallback.svg`;
        const previous = this.index.get(source);
        await writeFile(join(this.dir, file), body, { mode: 0o600 });
        this.index.set(source, { file, type: 'image/svg+xml', bytes: body.length, updatedAt: Date.now(), retryAt: Date.now() + RETRY_MS, status: 'fallback', sourceUrl: this.sources[source] });
        if (previous?.file && previous.file !== file) await unlink(join(this.dir, previous.file)).catch(() => {});
        await this.persist().catch(() => {});
        return { body, type: 'image/svg+xml', cached: false, fallback: true };
      }
    })();
    this.pending.set(source, task);
    task.then(() => { if (this.pending.get(source) === task) this.pending.delete(source); }, () => { if (this.pending.get(source) === task) this.pending.delete(source); });
    return task;
  }
  async get(source) {
    if (!Object.hasOwn(this.sources, source)) return null;
    const cached = await this.read(source);
    if (cached) return cached;
    // Give a first-party favicon a short chance to arrive with the source
    // card. If the network is slow or unavailable, return a deterministic
    // local mark while the same request continues warming the disk cache.
    const task = this.pending.get(source) || this.warm(source);
    const timer = new Promise(resolve => { const id = setTimeout(() => resolve(null), 1200); id.unref?.(); });
    const result = await Promise.race([task.catch(() => null), timer]);
    return result || { body: fallbackSourceIcon(source), type: 'image/svg+xml', cached: false, fallback: true };
  }
}
