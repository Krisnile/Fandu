import { createServer } from 'node:http';
import {randomUUID} from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { LibraryStore } from './lib/store.mjs';
import {EntryDraftStore,MAX_ENTRY_DRAFTS} from './lib/drafts.mjs';
import { resolveDataDirectory } from './lib/data-path.mjs';
import { Sources, Images } from './lib/sources.mjs';
import { CoverCache, COVER_CACHE_LIMITS } from './lib/cover-cache.mjs';
import { SourceIconCache, SOURCE_ICON_URLS } from './lib/source-icons.mjs';
import { DataDirectoryLease } from './lib/data-lease.mjs';
import { cleanupStorageTemporaryFiles } from './lib/storage-maintenance.mjs';
import {MigrationCoordinator} from './lib/migration.mjs';
import {createBackup,createTransferBundle,MAX_TRANSFER_BYTES} from './src/backup.js';
import { MAX_BYTES, imageUrl, customImageUrl } from './src/model.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const packageInfo = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const staticFiles = new Map([
  ['/', ['index.html','text/html; charset=utf-8']], ['/index.html',['index.html','text/html; charset=utf-8']],
  ['/fandu.png',['fandu.png','image/png']],
  ['/styles.css',['styles.css','text/css; charset=utf-8']],
  ['/controls.css',['controls.css','text/css; charset=utf-8']],
  ...['app','search','data','model','backup','autosave','insights','theme','addition','notices','library-save','edit-recovery','library-command'].map(x => [`/src/${x}.js`, [`src/${x}.js`, 'text/javascript; charset=utf-8']])
]);
const security = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Cache-Control':'no-store'
};
export { resolveDataDirectory };
async function readJson(req, maxBytes = MAX_BYTES) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Error('需要 JSON 数据');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > maxBytes + 4096) { const e = Error(`文件不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB`); e.status = 413; throw e; } chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function makeServer({ dataDir: requestedDataDir = resolveDataDirectory(), sources = new Sources(), onMigrationStage, accessToken } = {}) {
  const dataDir = resolve(requestedDataDir);
  const store = new LibraryStore(dataDir);
  const entryDrafts=new EntryDraftStore(dataDir,store);
  let coverCache, images, sourceIcons,migrations;
  const dataLease = new DataDirectoryLease(dataDir);
  let storageInitialization;
  const initializeStorage = () => storageInitialization ||= (async () => {
    coverCache = new CoverCache(join(dataDir,'covers'));
    sourceIcons = new SourceIconCache(join(dataDir,'source-icons'));
    images = new Images({ diskCache:coverCache });
    await Promise.all([coverCache.ready, sourceIcons.ready]);
    await cleanupStorageTemporaryFiles(dataDir);
    migrations=new MigrationCoordinator({dir:dataDir,store,covers:coverCache,onStage:onMigrationStage});
    // Keep the diagnostic UI reachable if a disk fault prevents recovery.
    // Protected storage routes remain closed until this decision completes.
    await migrations.run(async()=>{}).catch(()=>{});
  })();
  const cacheKeysFor = entries => new Set(entries.flatMap(item => {
    // A custom cover replaces the source cover in the UI; retaining only the
    // effective image keeps old source files from surviving a cover override.
    const custom = customImageUrl(item.customCover);
    const source = imageUrl(item.cover);
    return custom ? [`custom:${custom}`] : source ? [`source:${source}`] : [];
  }));
  const retainReferencedCovers = entries => coverCache.pruneUnreferenced(cacheKeysFor(entries)).catch(() => null);
  const revealDataDir = () => new Promise((resolve, reject) => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(command, [dataDir], { detached:true, stdio:'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve({ label: process.platform === 'darwin' ? 'Finder' : '文件管理器' }); });
  });
  let calls = 0, period = Date.now();
  const activeRequests=new Set();
  const server=createServer((req,res)=>{
    const task=handleRequest(req,res);activeRequests.add(task);
    task.finally(()=>activeRequests.delete(task)).catch(()=>{});
  });
  async function handleRequest(req,res) {
    const send = (status, data, type = 'application/json; charset=utf-8', extra = {}) => {
      if(res.destroyed)return;
      res.writeHead(status, { ...security, 'Content-Type': type, ...extra });
      res.end(req.method === 'HEAD' ? undefined : Buffer.isBuffer(data) ? data : type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      if (accessToken && req.headers['x-fandu-desktop-token'] !== accessToken) return send(403,{error:'请通过番渡桌面应用访问'});
      const host = req.headers.host;
      const allowedHosts = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]);
      if (!allowedHosts.has(host)) return send(403,{ error: '只允许本机访问' });
      const origin = `http://${host}`;
      if (req.headers.origin && req.headers.origin !== origin) return send(403,{ error: '不允许跨站请求' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403,{ error: '不允许跨站请求' });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/') && !['/api/image','/api/source-icon'].includes(url.pathname) && req.headers['x-yingjian'] !== '1') return send(403,{ error:'请通过番渡界面访问' });
      if (req.method === 'GET' && url.pathname === '/api/source-icon') {
        const source = url.searchParams.get('source') || '';
        if (!Object.hasOwn(SOURCE_ICON_URLS, source)) return send(404,{error:'未知数据源'});
        const icon = await sourceIcons.get(source);
        if (!icon) return send(404,{error:'图标暂不可用'});
        return send(200, icon.body, icon.type, { 'Cache-Control':'public, max-age=86400, stale-while-revalidate=604800' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const source = url.searchParams.get('source') || '';
        if (source === 'all') await sources.checkAll();
        else if (source) await sources.check(source);
        return send(200,{ sources: sources.health, storage: 'file', imageCacheBytes: images.cache.bytes + coverCache.bytes, memoryImageCacheBytes: images.cache.bytes, searchCacheBytes: sources.cache.bytes });
      }
      if (req.method === 'GET' && url.pathname === '/api/library') {
        return send(200,await migrations.run(async()=>{const library=await store.read();await retainReferencedCovers(library.entries);return library;}));
      }
      if(req.method==='POST'&&url.pathname==='/api/library/save'){
        const payload=await readJson(req);
        return send(200,await migrations.run(async()=>{const result=await store.saveWithReceipt(payload);await retainReferencedCovers(result.library.entries);return result;}));
      }
      if(req.method==='GET'&&url.pathname==='/api/library/save-status')return send(200,await migrations.run(()=>store.saveStatus(url.searchParams.get('id'))));
      if (req.method === 'POST' && url.pathname === '/api/entries/add') {
        const payload=await readJson(req);
        return send(200,await migrations.run(async()=>{
          let bound=false,result;
          try{
            if(payload.draftId && (await store.additionStatus(payload.requestId)).state!=='completed'){await entryDrafts.assertIntent(payload.draftId,payload);bound=true;}
            result=await store.addEntry(payload);
          }catch(error){
            if(bound && [400,409].includes(error.status))await entryDrafts.reject(payload.draftId,payload.requestId);
            if(!error.status)error.status=503;throw error;
          }
          if(payload.draftId)await entryDrafts.remove({id:payload.draftId,requestId:payload.requestId});
          return result;
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/entries/add-status') return send(200,await migrations.run(()=>store.additionStatus(url.searchParams.get('id'))));
      if (req.method === 'GET' && url.pathname === '/api/entry-drafts') return send(200,await migrations.run(async()=>({drafts:await entryDrafts.read(),limit:MAX_ENTRY_DRAFTS})));
      if (req.method === 'POST' && url.pathname === '/api/entry-drafts/allocate') return send(200,await migrations.run(()=>entryDrafts.allocate()));
      if (req.method === 'PUT' && url.pathname === '/api/entry-drafts') {const payload=await readJson(req);return send(200,await migrations.run(()=>entryDrafts.save(payload)));}
      if (req.method === 'POST' && url.pathname === '/api/entry-drafts/delete') {const payload=await readJson(req);return send(200,await migrations.run(()=>entryDrafts.remove(payload)));}
      if (req.method === 'POST' && url.pathname === '/api/entry-drafts/release') {
        const payload=await readJson(req);
        return send(200,await migrations.run(async()=>{
          const record=(await entryDrafts.read()).find(item=>item.id===payload.id);
          if(record?.intent && record.intent.requestId!==payload.requestId)throw Object.assign(Error('添加草稿已变化，不能解除原操作'),{status:409});
          const status=await store.additionStatus(payload.requestId);
          if(status.state==='completed')return status;
          if(!record)return {state:'released',record:null};
          await entryDrafts.reject(payload.id,payload.requestId);
          return {state:'released',record:(await entryDrafts.read()).find(item=>item.id===payload.id)};
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/backups') return send(200,await migrations.run(()=>store.listBackups()));
      if(req.method==='POST' && url.pathname==='/api/migrations/import')return send(200,await migrations.import(await readJson(req,MAX_TRANSFER_BYTES)));
      if(req.method==='GET' && url.pathname==='/api/migrations/status')return send(200,await migrations.status(url.searchParams.get('id')));
      if(req.method==='GET' && url.pathname==='/api/migrations/diagnostics')return send(200,await migrations.diagnostics());
      if(req.method==='POST' && url.pathname==='/api/migrations/diagnostics/export')return send(200,await migrations.exportDiagnostics());
      if(req.method==='POST' && url.pathname==='/api/migrations/diagnostics/retry')return send(200,await migrations.retryRecovery());
      if(req.method==='POST' && url.pathname==='/api/migrations/diagnostics/quarantine')return send(200,await migrations.quarantine(await readJson(req)));
      if(req.method==='POST' && url.pathname==='/api/migrations/export'){
        const request=await readJson(req);
        if(typeof request.includeCovers!=='boolean')throw Error('导出方式无效');
        return send(200,await migrations.run(async()=>{
          const library=await store.read();
          if(request.revision!==library.revision){const error=Error('其他窗口已修改档案，请刷新后再导出');error.status=409;throw error;}
          if(!request.includeCovers)return createBackup(library.entries,library.settings);
          await coverCache.pruneUnreferenced(cacheKeysFor(library.entries));
          return createTransferBundle(library.entries,library.settings,await coverCache.exportBundle());
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/app-info') return send(200,{
        version: typeof packageInfo.version === 'string' ? packageInfo.version : '',
        desktop: Boolean(accessToken),
        fileManager: process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? '文件资源管理器' : '文件管理器',
        dataDirectory: dataDir
      });
      if (req.method === 'POST' && url.pathname === '/api/data-folder') return send(200,await revealDataDir());
      if (req.method === 'POST' && url.pathname === '/api/backups/create') {const value=req.headers['content-length']==='0' || !req.headers['content-type']?{}:await readJson(req);return send(200,await migrations.run(()=>store.createSnapshot(value)));}
      if (req.method === 'POST' && url.pathname === '/api/backups/delete') {const value=await readJson(req);return send(200,await migrations.run(()=>store.deleteBackup(value)));}
      if (req.method === 'POST' && url.pathname === '/api/backups/restore') {const value=await readJson(req);return send(200,await migrations.restore(value.requestId?value:{...value,requestId:randomUUID()}));}
      if (req.method === 'POST' && url.pathname === '/api/covers/prune') {
        return send(200,await migrations.run(async()=>coverCache.pruneUnreferenced(cacheKeysFor((await store.read()).entries))));
      }
      if (req.method === 'GET' && url.pathname === '/api/covers/export') {
        return send(200,await migrations.run(async()=>{await coverCache.pruneUnreferenced(cacheKeysFor((await store.read()).entries));return coverCache.exportBundle();}));
      }
      if (req.method === 'POST' && url.pathname === '/api/covers/import') {const value=await readJson(req,COVER_CACHE_LIMITS.maxBundleBytes);return send(200,await migrations.run(()=>coverCache.importBundle(value)));}
      if (req.method === 'PUT' && url.pathname === '/api/library') {
        const value=await readJson(req);
        return send(200,await migrations.run(async()=>{const saved=await store.save(value);await retainReferencedCovers(saved.entries);return saved;}));
      }
      if (req.method === 'POST' && url.pathname === '/api/cover-check') {
        await migrations.run(async()=>{});
        if (Date.now() - period > 60_000) {calls=0;period=Date.now();}
        if (++calls > 180) return send(429,{error:'请求较多，请稍后重试'});
        await images.load((await readJson(req)).url, true);
        return send(200,{ok:true});
      }
      if (req.method === 'GET' && ['/api/catalog/search','/api/catalog/detail','/api/image'].includes(url.pathname)) {
        if (Date.now() - period > 60_000) { calls = 0; period = Date.now(); }
        if (++calls > 180) return send(429,{ error:'请求较多，请稍后重试' },undefined,{'Retry-After':'30'});
        if (url.pathname === '/api/catalog/search') {
          const q = (url.searchParams.get('q') || '').trim(), type = url.searchParams.get('type') || 'all';
          if (!q || q.length > 100 || !['all','anime','tv','movie'].includes(type)) return send(400,{error:'搜索词或筛选条件无效'});
          return send(200,await sources.search(url.searchParams.get('source') || 'bangumi',q,type));
        }
        if (url.pathname === '/api/catalog/detail') return send(200,await sources.detail(url.searchParams.get('id') || ''));
        const image = url.searchParams.get('url') || '', custom = url.searchParams.get('custom') === '1';
        await migrations.run(async()=>{});
        // Only saved custom links are displayable; previews require the protected POST endpoint.
        if (custom && !(await store.read()).entries.some(x=>x.customCover===image)) return send(403,{error:'请先保存封面链接'});
        const img = await images.load(image, custom);
        return send(200,img.body,img.type);
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog/season') {
        if (Date.now() - period > 60_000) { calls = 0; period = Date.now(); }
        if (++calls > 180) return send(429,{ error:'请求较多，请稍后重试' },undefined,{'Retry-After':'30'});
        return send(200,await sources.season(url.searchParams.get('year'),url.searchParams.get('season'),url.searchParams.get('page') || 1,url.searchParams.get('source') || 'auto'));
      }
      if (!['GET','HEAD'].includes(req.method)) return send(405,{error:'Method not allowed'});
      const file = staticFiles.get(url.pathname);
      if (!file) return send(404,{error:'Not found'});
      return send(200,await readFile(join(root,file[0])),file[1]);
    } catch (e) {
      send(e.status || 400,{error:e instanceof SyntaxError ? 'JSON 格式无效' : e.message || '请求失败',...(e.migrationPending?{migrationPending:true}:{}),...(e.draftRecovery?{draftRecovery:true}:{})});
    }
  }
  server.requestTimeout = 15_000;
  const listen = server.listen.bind(server);
  const close = server.close.bind(server);
  server.listen = (...args) => {
    Promise.resolve().then(async () => {
      await dataLease.acquire();
      try { await initializeStorage(); }
      catch (error) { await dataLease.release(); throw error; }
      const releaseOnFailure = () => { if (!server.listening) dataLease.release().catch(() => {}); };
      server.once('error', releaseOnFailure);
      server.once('listening', () => server.off('error', releaseOnFailure));
      try { listen(...args); }
      catch (error) {
        server.off('error', releaseOnFailure);
        await dataLease.release();
        throw error;
      }
    }).catch(error => queueMicrotask(() => server.emit('error', error)));
    return server;
  };
  server.close = callback => {
    close(error => {
      // A disconnected HTTP client can leave its async file write running.
      // Drain handlers before releasing ownership to a newly started server.
      Promise.allSettled([...activeRequests]).then(()=>dataLease.release()).then(
        () => callback?.(error),
        releaseError => callback?.(error || releaseError)
      );
    });
    return server;
  };
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = makeServer();
  server.listen(Number(process.env.PORT || 4173),'127.0.0.1',() => console.log(`番渡 Fandu 已启动：http://127.0.0.1:${server.address().port}`));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口已被占用，请打开现有番渡或设置 PORT。' : e.message); process.exitCode = 1; });
  const shutdown = () => {
    const timer = setTimeout(() => server.closeAllConnections?.(), 2_000);
    timer.unref();
    server.close(error => {
      clearTimeout(timer);
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') { console.error(error.message); process.exitCode = 1; }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
