import { TYPE, STATUS } from './data.js';
import { entry, validateLibrary, MAX_LISTS, MAX_MANAGED_TAGS, MAX_ENTRY_TAGS, MAX_SERIES, imageUrl, customImageUrl, preferences, pageLayout, sourceUrl } from './model.js';
import { fuzzySearch, normalizeText, scoreEntry } from './search.js';
import { parsePortableBundle, mergeBackup, MAX_TRANSFER_BYTES } from './backup.js?v=0.3.3';
import { createAutosave } from './autosave.js';
import { sortEntries, summarizeEntries, timelineGroups, premiereStamp, premiereYear, premiereDetail } from './insights.js';
import { readableAccent, onAccent } from './theme.js';
import { resolveAddition } from './addition.js';
import { createNotices } from './notices.js';
import {createSaveCoordinator} from './library-save.js';
import {createEditRecovery,applyRecoveredFields} from './edit-recovery.js';
import {libraryCommand,applyLibraryCommand} from './library-command.js';

const $ = id => document.getElementById(id);
const storageRecoveryHome=$('migrationRecovery').parentElement;
const storageRecoveryAnchor=$('migrationRecovery').nextElementSibling;
document.querySelector('.content-wrap').append($('searchView'));
document.querySelectorAll('select').forEach(select => select.classList.add('ui-control'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const SOURCE_META = {
  bangumi:{label:'Bangumi', kind:'api', searchable:true, href:'https://bangumi.github.io/api/'},
  tvmaze:{label:'TVmaze', kind:'api', searchable:true, href:'https://www.tvmaze.com/api'},
  kitsu:{label:'Kitsu', kind:'api', searchable:true, href:'https://hummingbird-me.github.io/api-docs/'},
  jikan:{label:'Jikan / MAL', kind:'api', searchable:true, href:'https://docs.jikan.moe/'},
  wikidata:{label:'Wikidata', kind:'api', searchable:true, href:'https://www.wikidata.org/wiki/Wikidata:Data_access'},
  wikipedia:{label:'Wikipedia', kind:'api', searchable:true, href:'https://www.mediawiki.org/wiki/API:Main_page'},
  ann:{label:'Anime News Network', kind:'api', searchable:true, href:'https://www.animenewsnetwork.com/encyclopedia/api.php'},
  yuc:{label:'Yuc · 长门番堂', kind:'catalog', seasonal:true, href:'https://yuc.wiki/'},
  douban:{label:'豆瓣电影', kind:'site', href:'https://movie.douban.com/'},
  imdb:{label:'IMDb', kind:'site', href:'https://www.imdb.com/'},
  anidb:{label:'AniDB', kind:'site', href:'https://anidb.net/'}
};
const SOURCE_MARKS = { bangumi:'B', tvmaze:'TV', kitsu:'K', jikan:'MAL', wikidata:'WD', wikipedia:'W', ann:'ANN', douban:'豆', imdb:'IMDb', anidb:'A', yuc:'YUC', manual:'手' };
const NAMES = { ...Object.fromEntries(Object.entries(SOURCE_META).map(([key,value])=>[key,value.label])), yuc:'Yuc · 长门番堂', manual:'本地录入', anilist:'AniList' };
const SOURCE_KEYS = Object.keys(SOURCE_META);
const SEARCH_SOURCES = ['bangumi','tvmaze','kitsu','jikan','wikidata','wikipedia','ann'];
const HEALTH = { untested:'未测试', ok:'连接正常', cached:'使用缓存', stale:'离线缓存', unavailable:'暂不可用', site_only:'站点入口' };
let library = { revision: 0, entries: [] }, loaded = false, saving = false;
let collectionInteractionVersion=0;
for(const type of ['pointerdown','keydown'])document.addEventListener(type,()=>{collectionInteractionVersion++;},true);
let workspace = 'collection', view = 'library', filterType = 'all', tag = '', archiveYear = null, archiveSeason = '', seriesFilter = '', seriesFilterText = '';
const CATALOG_BATCH = 48;
let toolTab = 'timeline', catalogFilters = { year:'', season:'', region:'', list:'', type:'' }, catalogShown = CATALOG_BATCH, seasonItems = [], seasonLoading = false;
let seasonPage = 0, seasonHasNext = false, seasonError = '', seasonFailureKind = '', seasonFetched = '', seasonVersion = 0, seasonLoaded = false, seasonTotal = null, seasonDay = '', seasonSource = '', seasonAbort = null;
let timelineField = 'premiere', timelineDecade = '', timelineShown = 120, timelineKey = '', settingsStatus = 'saved';
let seasonQuery = { year: new Date().getFullYear(), season: ['冬','春','夏','秋'][Math.floor(new Date().getMonth()/3)] };
let settingsTab = 'general', tagSearch = '', seriesSearch = '';
let dataOperation = '';
let importAttempt = null;
let snapshotRestoreAttempt = null;
const pendingDataResult=()=>Boolean(importAttempt?.pending || snapshotRestoreAttempt?.pending || migrationRepairAttempt?.pending);
let dataOperationFocus = 'importState';
const dataLockedControls = new Map();
let pendingListDelete = '', pendingTagDelete = '', pendingSeriesDelete = '';
const managerNames = new Map();
const managerDeleteErrors = new Map();
function managerDeleteMessage(kind,id) {
  const error=managerDeleteErrors.get(managerNameKey(kind,id));
  return error?`<span class="manager-operation-error" role="status">${esc(error)}</span>`:'';
}
function setManagerDeleteBusy(button,busy) {
  const group=button.closest('[role=group]');
  group?.setAttribute('aria-busy',String(busy));
  group?.querySelectorAll('button').forEach(control=>{control.disabled=busy;});
}
let seriesPickerIndex = 0;
let appInfo = null, appInfoPromise = null;
let current = null, editId = null, dirty = false, lastFocus = null, activeDialog = null;
let noteStatus = 'saved';
let entryEditSaveStatus = 'saved';
let entryObservedDraft = null, entryChangedFields = new Set();
let editRecovery=null,editRecoveryTail=Promise.resolve(),editRecoverableRecords=[],editRecoveryError='';
let editDiscardId='';
let migrationDiagnostics=null,migrationDiagnosticError='',migrationDiagnosticMessage='',migrationDiagnosticReady=false,migrationDiagnosticBusy=false,migrationConfirmId='',migrationRepairAttempt=null;
let storageRecoveryInline=false,entryDraftRecoveryNotice=null;
let savingCommand=null,editRepairSnapshot=null,activeSaveRequestId=null,repairBusy=false;
const editDrafts=new Map();
let noteComposing = false, detailRedrawPending = false;
let formDirty = false;
let formVersion = 0, formComposing = false;
let entryAdding=false, entryAddAttempt=null, entryDiscardOpen=false, entryDiscardFocus=null, entryBaseline='';
const entryLockedControls=new Map(), entryInvalidControls=new Map();
let formDraftRecord=null, recoveryRecords=[], recoveryError='', recoveryVersion=0, lastQueuedDraftSignature='';
let recoveryLoading=false, recoveryReadSequence=0;
let detailAdding=false, detailAddAttempt=null;
const recoveryById=new Map();
const recoveryAllocations=new Map();
const recoveryAllocationOrigins=new Map();
const draftWriteVersions=new Map();
const lastSentDrafts=new Map();
let recoveryDiscard=null, recoveryDeleting=false, recoveryDeleteError='';
let searchVersion = 0, searchTimer, searchAbort, results = [], selected = -1, sourceResults = {}, searchType = 'all';
let searchQuery = '', searchOnline = false;
let searchSeasonItems = [], searchSeasonLoading = false, searchSeasonError = '', searchSeasonFetched = '', searchSeasonSource = '', searchSeasonLoaded = false, searchSeasonAbort = null;
let searchWaiting = false;
// Keep keyword search calm on both sides of the network boundary.  A user can
// type several intermediate queries in a few seconds; the browser cache and a
// short source backoff prevent those transient strings from becoming a burst
// of repeated upstream requests.
const SEARCH_CACHE_TTL = 10 * 60_000;
const SEARCH_CACHE_MAX = 80;
const SEARCH_CONCURRENCY = 3;
const searchCache = new Map();
const searchBackoff = new Map();
const searchCacheKey = (source, query, type) => `${source}:${type}:${normalizeText(query).toLowerCase()}`;
function readSearchCache(source, query, type) {
  const key = searchCacheKey(source, query, type), cached = searchCache.get(key);
  if (!cached || Date.now() - cached.savedAt > SEARCH_CACHE_TTL) { if (cached) searchCache.delete(key); return null; }
  // Touch the entry so the map behaves as a small LRU rather than a growing
  // record of every typo ever entered in this browser session.
  searchCache.delete(key); searchCache.set(key, cached);
  return cached.value;
}
function writeSearchCache(source, query, type, value) {
  const key = searchCacheKey(source, query, type);
  // Only successful responses belong in the fresh result cache. A 200
  // response can still describe an upstream outage; caching it as a hit
  // would turn that outage into a false empty result on the next search.
  if (!['ok','cached'].includes(value?.state)) { searchCache.delete(key); return; }
  searchCache.delete(key); searchCache.set(key, { savedAt:Date.now(), value });
  while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
}
let manualEnrichQuery = '';
// A remote result can be opened in the add form before it exists in the
// collection. Keep its provider metadata as a seed so saving the form does
// not throw away the cover, source id or background that was already found.
let entrySeed = null;
const pendingImages = new Set();
const SEASON_CACHE_MAX_AGE = 24 * 3600_000;
const SEASON_CACHE_MAX_ENTRIES = 12;
// Yuc's public archive starts at the 2019 autumn index.  The picker mirrors
// that published index instead of offering arbitrary years that would only
// produce a confusing empty/error page.  The current year is kept as the
// upper bound because Yuc may publish its October index before the quarter
// begins; a future year is not shown until the site itself adds it.
const YUC_SEASON_MIN_YEAR = 2019;
const YUC_SEASON_MAX_YEAR = new Date().getFullYear();
const YUC_SEASONS = Object.freeze(['冬','春','夏','秋']);
function isYucQuarterAvailable(year, season) {
  const yearNumber = Number(year);
  if (!Number.isInteger(yearNumber) || yearNumber < YUC_SEASON_MIN_YEAR || yearNumber > YUC_SEASON_MAX_YEAR) return false;
  return yearNumber > YUC_SEASON_MIN_YEAR || season === '秋';
}
function normalizeYucQuarter(year, season) {
  const yearNumber = Number(year);
  return { year: yearNumber, season: isYucQuarterAvailable(yearNumber, season) ? season : '秋' };
}
const seasonCacheKey = (year, season, pageNumber = 1) => 'fandu-season:' + year + ':' + season + ':' + pageNumber;
function readSeasonCache(year, season, pageNumber = 1) {
  try {
    const raw = localStorage.getItem(seasonCacheKey(year, season, pageNumber));
    if (!raw) return null;
    const cached = JSON.parse(raw), savedAt = Date.parse(cached?.savedAt || '');
    // Quarter browsing is a Yuc-shaped remote catalogue.  Older builds could
    // have written a Jikan/Kitsu response under the same key; never surface
    // that stale shape as if it were the Yuc index.  It is safer to revalidate
    // the fixed upstream page than to silently change the scope of the view.
    if (!cached?.data || cached.data.source !== 'yuc' || !Array.isArray(cached.data.results) || !Number.isFinite(savedAt) || Date.now() - savedAt > SEASON_CACHE_MAX_AGE) return null;
    return cached.data;
  } catch { return null; }
}
function cachedSeasonEntries(cached, year, season, strictNew = false) {
  return (cached?.results || []).map(raw => {
    try { return entry(raw); } catch { return null; }
  }).filter(item => item && item.type === 'anime' && item.year === year && item.season === season && (!strictNew || item.seasonNew));
}
function writeSeasonCache(year, season, pageNumber, data) {
  try {
    const payload = { ...data, results: Array.isArray(data?.results) ? data.results.slice(0, 120) : [] };
    const fetchedAt = Date.parse(data?.fetchedAt || ''), savedAt = Number.isFinite(fetchedAt) ? new Date(fetchedAt).toISOString() : new Date().toISOString();
    localStorage.setItem(seasonCacheKey(year, season, pageNumber), JSON.stringify({ savedAt, data: payload }));
    const cachedKeys = Object.keys(localStorage).filter(key => key.startsWith('fandu-season:')).map(key => {
      try { return { key, savedAt: Date.parse(JSON.parse(localStorage.getItem(key))?.savedAt || '') }; } catch { return { key, savedAt: 0 }; }
    }).sort((a, b) => b.savedAt - a.savedAt);
    cachedKeys.slice(SEASON_CACHE_MAX_ENTRIES).forEach(item => localStorage.removeItem(item.key));
  } catch { /* Private browsing or a full quota must never block remote results. */ }
}
let page = 1, effectiveLayout;
const WORKSPACE_STATE_KEY = 'fandu:last-workspace';
function readWorkspaceState() {
  try { return JSON.parse(localStorage.getItem(WORKSPACE_STATE_KEY) || 'null') || {}; } catch { return {}; }
}
function writeWorkspaceState() {
  try {
    localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify({
      workspace, view, toolTab, page, filterType, tag, archiveYear, archiveSeason, seriesFilter, seriesFilterText
    }));
  } catch { /* Storage can be unavailable in private browsing. */ }
}
function restoreWorkspaceState() {
  const saved = readWorkspaceState();
  workspace = ['collection','sources','tools','search'].includes(saved.workspace) ? saved.workspace : 'collection';
  view = typeof saved.view === 'string' && saved.view ? saved.view : 'library';
  toolTab = ['timeline','catalog','season','maintenance'].includes(saved.toolTab) ? saved.toolTab : 'timeline';
  page = Number.isInteger(saved.page) && saved.page > 0 ? saved.page : 1;
  filterType = ['all','anime','movie','tv'].includes(saved.filterType) ? saved.filterType : 'all';
  tag = typeof saved.tag === 'string' ? saved.tag.slice(0,40) : '';
  archiveYear = Number.isInteger(saved.archiveYear) ? saved.archiveYear : null;
  archiveSeason = typeof saved.archiveSeason === 'string' ? saved.archiveSeason : '';
  seriesFilter = typeof saved.seriesFilter === 'string' ? saved.seriesFilter : '';
  seriesFilterText = typeof saved.seriesFilterText === 'string' ? saved.seriesFilterText.slice(0,40) : '';
}
let coverVersion = 0;
let selectionMode = false;
const sourceTesting = new Set();
let sourceHealth = {};
const selectedIds = new Set();
const LIST_ICONS = { all:'▦', watching:'▶', planned:'＋', completed:'✓', paused:'Ⅱ' };
let pointerListDrag = null;
let continuousShown = 120, continuousKey = '';
let settingsDraft = {}, commitTail = Promise.resolve();
const uiPreferences = () => preferences({ ...library.settings, ...settingsDraft });
const entrySave = createAutosave({
  delay:450,
  write:async ({draft})=>{
    if(!draft.valid)throw Error('请检查必填项和数值范围');
    entryFromDraft(draft,library.entries.find(x=>x.id===draft.id));
    const ok=await commit(()=>{
      const previous=library.entries.find(x=>x.id===draft.id);
      if(!previous)throw Error('作品已不存在，未写入修改');
      const next=entryFromDraft(draft,previous);
      return library.entries.map(x=>x.id===draft.id?next:x);
    });
    if(!ok)throw Error('保存失败，修改仍保留');
    await forgetEdit('form',draft.id,draft.recoveryVersion);
    if(editId===draft.id && formVersion===draft.version)formDirty=false;
  },
  state:(status,error)=>{
    entryEditSaveStatus=status;
    $('entrySaveState').textContent=status==='error'?error?.message||'保存失败':saveStatusLabel(status);
    $('retryEntrySave').hidden=status!=='error';
  }
});
const formDraftSave=createAutosave({
  delay:450,
  write:async ({id,draft})=>{
    const record=await saveRecoveryDraft(id,draft);
    if(formDraftRecord?.id===id||formDraftRecord?.id===record.id)formDraftRecord=record;
  },
  state:(status,error)=>{
    if(editId || status==='canceled')return;
    $('entrySaveState').hidden=!formDirty;
    $('entrySaveState').textContent=({pending:'草稿待保存',saving:'保存草稿…',saved:'草稿已保存',error:'草稿未保存'})[status];
    $('retryEntrySave').hidden=status!=='error';
    $('forkEntryDraft').hidden=status!=='error'||error?.status!==409;
    if(status==='error'){
      const message=errorMessage(error).replace(/[。.!！]+$/u,'');
      entryAddNotice(error?.status===409
        ?'草稿未保存：这份草稿已变化或不能继续保存。当前输入仍保留，可保留为另一份草稿。'
        :`草稿未保存：${message}。${message.includes('当前输入仍保留')?'':'当前输入仍保留。'}`);
    }
  }
});
const noteSave = createAutosave({
  delay:450,
  write:async patch=>{
    const ok=await commit(()=>library.entries.map(x=>Object.hasOwn(patch,x.id)?{...x,note:patch[x.id].value,updatedAt:new Date().toISOString()}:x));
    if(!ok)throw Error('笔记保存失败');
    for(const [id,draft] of Object.entries(patch))await forgetEdit('note',id,draft.version);
    if(current && Object.hasOwn(patch,current.id) && $('noteInput')?.value===patch[current.id].value) {
      const saved=library.entries.find(item=>item.id===current.id);
      if(saved){current=saved;$('noteInput').value=saved.note;}
      dirty=false;
    }
  },
  state:setNoteStatus
});
function saveStatusLabel(status) { return saveCoordinator.unconfirmed&&['pending','saving'].includes(status)?'待核对':({pending:'待保存',saving:'保存中…',saved:'已保存',error:'保存失败'})[status]; }
function noteStatusText() { return saveStatusLabel(noteStatus); }
function setNoteStatus(status) {
  noteStatus=status;
  if($('noteSaveState'))$('noteSaveState').textContent=noteStatusText();
  if($('retryNote'))$('retryNote').hidden=status!=='error';
}
function queueNoteEdit(value,schedule=true){
  if(!current)return;
  const version=rememberEdit('note',current.id,{value},current.title);
  if(schedule)noteSave.schedule({[current.id]:{value,version}});
}
const settingsSave = createAutosave({
  write: async patch => {
    const {__recoveryVersion,...values}=patch;
    const ok = await commit(() => library.entries, '', () => ({ ...library.settings, ...values }), {render:false});
    if (!ok) throw Error('修改尚未写入本地文件');
    await forgetEdit('settings','',__recoveryVersion);
    for (const key of Object.keys(values)) if (JSON.stringify(settingsDraft[key]) === JSON.stringify(values[key])) delete settingsDraft[key];
    applyPreferences();
  },
  state: status => {
    settingsStatus = status;
    const label = saveStatusLabel(status);
    if ($('generalSaveState')) {
      $('generalSaveState').textContent = label;
      $('generalSaveState').hidden = status === 'saved';
      $('generalSaveState').parentElement.hidden = status === 'saved';
    }
    if ($('sourceSaveState')) {
      $('sourceSaveState').textContent = label;
      $('sourceSaveState').hidden = status === 'saved';
    }
    $('retrySettings').hidden = status !== 'error';
    $('retrySourceSettings').hidden = status !== 'error';
  }
});
function savePreferences(patch) {
  settingsDraft = { ...settingsDraft, ...patch };
  const version=rememberEdit('settings','',settingsDraft,'外观与设置');
  settingsSave.schedule({...patch,__recoveryVersion:version});
  // Theme, mode, accent and source/timeline preferences only change tokens or
  // another workspace's controls. Applying them in place keeps the collection
  // DOM (and its already loaded cover images) intact. Rebuild the collection
  // only when a preference changes its layout, ordering, metadata or count.
  const redrawCollection = ['columns','rows','time','display','view','sort'].some(key => Object.hasOwn(patch, key));
  if (redrawCollection) render(); else applyPreferences();
}

function updateThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
}
function applyPreferences() {
  const prefs = uiPreferences();
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.mode = prefs.mode;
  document.documentElement.dataset.counts = String(prefs.display.count);
  for (const key of ['--accent','--accent-strong','--blue','--persimmon','--on-accent','--on-accent-fill','--accent-text']) document.documentElement.style.removeProperty(key);
  if (prefs.accent) {
    for (const key of ['--accent','--accent-strong','--blue','--persimmon']) document.documentElement.style.setProperty(key,prefs.accent);
    document.documentElement.style.setProperty('--on-accent',onAccent(prefs.accent));
  }
  const style=getComputedStyle(document.documentElement),accent=style.getPropertyValue('--accent').trim();
  const surfaces=['--paper','--sidebar','--panel','--panel-2','--input'].map(token=>style.getPropertyValue(token).trim());
  document.documentElement.style.setProperty('--accent-text',readableAccent(accent,surfaces,prefs.mode));
  document.documentElement.style.setProperty('--on-accent-fill',onAccent(accent));
  updateThemeColor();
}
function listEntries(list) {
  if (list.kind === 'all') return library.entries;
  if (list.kind === 'status') return library.entries.filter(x => x.status === list.status);
  return library.entries.filter(x => x.lists.includes(list.id));
}
function renderNav() {
  const prefs = uiPreferences();
  const root = prefs.lists.find(x => x.kind === 'all') || { id:'library', label:'收藏', kind:'all' };
  if (!prefs.lists.some(x => x.id === view)) view = root.id;
  const nested = prefs.lists.filter(x => x.id !== root.id);
  const listButtons = nested.map(list => {
    const icon = LIST_ICONS[list.status || list.id] || '□';
    return `<button class="nav-item ${workspace === 'collection' && view === list.id ? 'active' : ''}" data-view="${esc(list.id)}"><span class="nav-icon">${icon}</span><span class="nav-label" title="${esc(list.label)}">${esc(list.label)}</span><span class="nav-count">${listEntries(list).length}</span></button>`;
  }).join('');
  $('primaryNav').innerHTML = `<div class="sidebar-group"><button class="nav-folder ${workspace==='search'?'active':''}" data-search-open><span>⌕</span><b>搜索</b><kbd>⌘ K</kbd></button></div><div class="sidebar-group"><button class="nav-folder ${workspace === 'collection' && view === root.id ? 'active' : ''}" data-view="${esc(root.id)}"><span>▦</span><b>${esc(root.label)}</b><span class="nav-count">${listEntries(root).length}</span></button><div class="nav-children">${listButtons}</div></div><div class="sidebar-group"><button class="nav-folder ${workspace === 'sources' ? 'active' : ''}" data-source-open><span>◈</span><b>数据源</b><span>›</span></button></div><div class="sidebar-group"><button class="nav-folder ${workspace === 'tools' ? 'active' : ''}" data-tools-open><span>⌘</span><b>工具</b><span>›</span></button></div>`;
  $('primaryNav').querySelector('.active')?.setAttribute('aria-current', 'page');
}
function cancelSeasonRequest() {
  seasonVersion++;
  seasonAbort?.abort();
  seasonAbort = null;
  seasonLoading = false;
}
function cancelSearchSeasonRequest() {
  searchSeasonAbort?.abort();
  searchSeasonAbort = null;
  searchSeasonLoading = false;
}
function cancelSearchRequests() {
  searchVersion++;
  searchAbort?.abort();
  searchAbort = null;
  cancelSearchSeasonRequest();
}
function openWorkspace(next) {
  const previousWorkspace = workspace;
  workspace = ['collection','sources','tools','search'].includes(next) ? next : 'collection';
  writeWorkspaceState();
  if (previousWorkspace === 'tools' && workspace !== 'tools') cancelSeasonRequest();
  if (previousWorkspace === 'search' && workspace !== 'search') cancelSearchRequests();
  if (workspace !== 'collection') { selectionMode = false; selectedIds.clear(); }
  $('collectionSection').hidden = workspace !== 'collection';
  $('sourceView').hidden = workspace !== 'sources';
  $('toolsView').hidden = workspace !== 'tools';
  $('searchView').hidden = workspace !== 'search';
  $('addWork').hidden = workspace !== 'collection';
  document.body.classList.remove('menu-open'); syncNav();
  // Workspaces are separate tasks rather than one long document.  Returning
  // to a different task should start at its heading; otherwise a deep scroll
  // in a large collection can make the new page appear empty or title-less.
  if (previousWorkspace !== workspace) window.scrollTo(0, 0);
  renderNav();
  if (workspace === 'collection') render();
  if (workspace === 'sources') {
    loadSourceSettings();
    // Paint the fixed source inventory immediately.  A slow first health
    // probe should update these cards in place instead of leaving an empty
    // workspace that looks like a failed render.
    renderSourceRows(sourceHealth);
    health();
  }
  if (workspace === 'tools') renderToolsHome();
  if (workspace === 'search') {
    renderSearch();
    if (!searchQuery && !searchSeasonLoaded) loadSearchSeason();
    // Return to the same query after changing source switches. Successful
    // results still use the cache, while newly enabled sources are queried.
    if (previousWorkspace === 'sources' && searchQuery && searchOnline) void remoteSearch();
  }
  const heading = $(workspace === 'collection' ? 'sectionTitle' : workspace === 'sources' ? 'sourcePageTitle' : workspace === 'search' ? 'searchTitle' : 'toolsPageTitle');
  heading.tabIndex = -1; heading.focus({preventScroll:true});
}
function loadSourceSettings() {
  const state = ({pending:'待保存',saving:'保存中…',saved:'已保存',error:'保存失败'})[settingsStatus];
  if ($('sourceSaveState')) { $('sourceSaveState').textContent = state; $('sourceSaveState').hidden = settingsStatus === 'saved'; }
  if ($('retrySourceSettings')) $('retrySourceSettings').hidden = settingsStatus !== 'error';
}
function runDataAudit() {
  const prefs = uiPreferences(), listIds = new Set(prefs.lists.map(x => x.id)), seriesIds = new Set(prefs.series.map(x => x.id));
  const orphanLists = library.entries.reduce((n, x) => n + x.lists.filter(id => !listIds.has(id)).length, 0);
  const orphanSeries = library.entries.filter(x => x.seriesId && !seriesIds.has(x.seriesId)).length;
  const missingCovers = library.entries.filter(x => !customImageUrl(x.customCover) && !imageUrl(x.cover)).length;
  const missingDescriptions = library.entries.filter(x => !String(x.description || '').trim()).length;
  const missingSources = library.entries.filter(x => x.sourceId && !sourceUrl(x.sourceId)).length;
  const automatic = library.entries.filter(x => x.source !== 'manual');
  const manual = library.entries.length - automatic.length;
  // Games and other non-episodic records use the same compact entry model,
  // but an empty episode total is not missing metadata for them.  Keeping this
  // distinction in the audit prevents a game imported from Bangumi from being
  // reported as an unfinished TV record.
  const needsEpisodeTotal = x => x.type !== 'movie' && !/游戏|game/i.test(String(x.format || ''));
  // A source may intentionally leave announced projects open-ended. Keep
  // those counts visible as provenance information, but do not present them
  // as broken records that need guessed values.
  const unpublished = {
    year: automatic.filter(x => !x.year).length,
    premiere: automatic.filter(x => !x.airedAt).length,
    total: automatic.filter(x => needsEpisodeTotal(x) && !x.total).length,
    studio: automatic.filter(x => !x.studios.length).length
  };
  const issues = [];
  if (orphanLists) issues.push(`${orphanLists} 个列表引用已失效`);
  if (orphanSeries) issues.push(`${orphanSeries} 部作品的系列引用已失效`);
  if (missingSources) issues.push(`${missingSources} 条来源编号无法识别`);
  if (missingCovers) issues.push(`${missingCovers} 部作品没有可用封面链接`);
  if (missingDescriptions) issues.push(`${missingDescriptions} 部作品没有简介`);
  const report = $('toolsReport');
  if (!report) return;
  if ($('auditScope')) $('auditScope').textContent = `${library.entries.length} 部作品`;
  if (!library.entries.length) { report.innerHTML = '<div class="audit-surface"><div class="audit-empty">暂无作品</div></div>'; return; }
  const pending = Object.entries({year:'年份',premiere:'首播日期',total:'总集数',studio:'制作公司'})
    .filter(([key]) => unpublished[key])
    .map(([key,label]) => `${label} ${unpublished[key]} 条未公布`);
  const pendingRecords = automatic.filter(x => !x.year || !x.airedAt || (needsEpisodeTotal(x) && !x.total) || !x.studios.length);
  const pendingDetails = pendingRecords.length ? `<details class="audit-pending"><summary>查看 ${pendingRecords.length} 部作品</summary><ul>${pendingRecords.map(x => {
    const fields = [!x.year && '年份', !x.airedAt && '首播日期', (needsEpisodeTotal(x) && !x.total) && '总集数', !x.studios.length && '制作公司'].filter(Boolean).join('、');
    const href = sourceUrl(x.sourceId) || x.sourceUrl;
    return `<li><span>${esc(x.title)} · ${fields}</span>${href ? ` <a href="${esc(href)}" target="_blank" rel="noreferrer">来源 ↗</a>` : ''}</li>`;
  }).join('')}</ul></details>` : '';
  const coverage = (label, complete) => `<div class="audit-coverage-row"><span>${label}</span><div class="audit-meter" aria-hidden="true"><i style="width:${library.entries.length ? complete/library.entries.length*100 : 0}%"></i></div><b>${complete}/${library.entries.length}</b></div>`;
  const pendingSection = pending.length ? `<section class="audit-source-pending"><header><b>来源尚未公布</b><span>${pendingRecords.length} 部</span></header><p>${pending.join(' · ')}</p>${pendingDetails}</section>` : '';
  report.innerHTML = `<div class="audit-surface"><div class="audit-layout"><section class="audit-verdict ${issues.length?'has-issues':'is-ok'}"><span>档案结构</span><strong>${issues.length ? `${issues.length} 类需要处理` : '检查通过'}</strong>${issues.length ? `<ul>${issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>列表、系列、来源与封面引用均有效</p>'}</section><section class="audit-coverage"><div class="audit-source-mix"><span>来源</span><b>${automatic.length} 自动</b><small>${manual} 手动</small></div>${coverage('简介',library.entries.length-missingDescriptions)}${coverage('封面',library.entries.length-missingCovers)}</section></div>${pendingSection}</div>`;
}
function renderToolsHome() {
  const home = $('toolHome');
  if (!home) return;
  const years = library.entries.map(premiereYear).filter(year => year !== null);
  const automatic = library.entries.filter(item => item.source !== 'manual').length;
  if ($('toolTimelineMeta')) $('toolTimelineMeta').textContent = years.length ? `${Math.min(...years)}—${Math.max(...years)}` : '暂无首播资料';
  if ($('toolCatalogMeta')) $('toolCatalogMeta').textContent = `${library.entries.length} 部可筛选`;
  if ($('toolSeasonMeta')) $('toolSeasonMeta').textContent = `${seasonQuery.year} · ${seasonQuery.season}季`;
  if ($('toolMaintenanceMeta')) $('toolMaintenanceMeta').textContent = `${automatic} 条自动来源`;
  home.hidden = false;
  $('toolsTabs').hidden = true;
  $('toolsHomeBack').hidden = true;
  document.querySelectorAll('[data-tool-panel]').forEach(p => { p.hidden = true; });
  $('toolsReport').hidden = true;
  document.querySelectorAll('[data-tool-hub]').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed','false');
  });
  if ($('toolHubState')) $('toolHubState').textContent = '工具首页';
}
function toolTabs(tab = toolTab) {
  toolTab = ['timeline','catalog','season','maintenance'].includes(tab) ? tab : 'timeline';
  writeWorkspaceState();
  $('toolHome').hidden = true;
  $('toolsTabs').hidden = false;
  $('toolsHomeBack').hidden = false;
  document.querySelectorAll('[data-tool-hub]').forEach(b => {
    const active = b.dataset.toolHub === toolTab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  if ($('toolHubState')) $('toolHubState').textContent = `当前：${({timeline:'时间轴',catalog:'目录',season:'季度查询',maintenance:'整理'})[toolTab]}`;
  document.querySelectorAll('[data-tool-tab]').forEach(b => {
    const active = b.dataset.toolTab === toolTab;
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-tool-panel]').forEach(p => p.hidden = p.dataset.toolPanel !== toolTab);
  $('toolsReport').hidden = toolTab !== 'maintenance';
  if (toolTab === 'timeline') renderTimeline();
  if (toolTab === 'catalog') renderCatalog();
  if (toolTab === 'season') { renderSeason(); if (!seasonLoaded && !seasonLoading) loadSeason(); }
  if (toolTab === 'maintenance') runDataAudit();
}
function toolCard(item) {
  return `<button type="button" class="tool-work" data-tool-open="${esc(item.id)}"><div class="tool-work-cover">${picture(item,'mini-cover')}</div><div><b>${esc(item.title)}</b><span>${item.year || '年份未知'} · ${TYPE[item.type] || '作品'}${item.region ? ` · ${esc(item.region)}` : ''}</span></div></button>`;
}
function renderCollectionOverview(items = library.entries) {
  const target = $('collectionOverview');
  if (!target) return;
  const stats = summarizeEntries(items), recent = sortEntries(items, 'premiere').slice(0, 8);
  const knownYears = items.map(premiereYear).filter(Boolean).sort((a,b) => a - b);
  const decadeCounts = new Map();
  for (const item of items) {
    const year = premiereYear(item);
    const label = year ? `${Math.floor(year / 10) * 10}年代` : '未知';
    decadeCounts.set(label, (decadeCounts.get(label) || 0) + 1);
  }
  const decades = [...decadeCounts].sort(([a],[b]) => {
    if (a === '未知') return 1;
    if (b === '未知') return -1;
    return Number.parseInt(b, 10) - Number.parseInt(a, 10);
  });
  const premiereText = item => {
    if (item.airedAt) {
      const date = new Date(item.airedAt);
      if (Number.isFinite(date.getTime())) return date.toLocaleDateString('zh-CN', {year:'numeric', month:'numeric', day:'numeric', timeZone:'UTC'});
    }
    if (item.year) return `${item.year}${item.season ? ` · ${item.season}季` : ''}`;
    return '首播未知';
  };
  const bars = (values, labels) => Object.entries(values).map(([key, count]) => `<div class="distribution-row"><span>${esc(labels[key])}</span><div class="distribution-track" aria-hidden="true"><i style="width:${stats.total ? count / stats.total * 100 : 0}%"></i></div><b>${count}</b></div>`).join('');
  const decadeBars = decades.map(([label,count]) => `<div class="distribution-row"><span>${esc(label)}</span><div class="distribution-track" aria-hidden="true"><i style="width:${stats.total ? count / stats.total * 100 : 0}%"></i></div><b>${count}</b></div>`).join('');
  const yearSpan = knownYears.length ? `${knownYears[0]}—${knownYears.at(-1)}` : '—';
  target.innerHTML = `<div class="dashboard-grid"><div class="metric-card metric-accent"><span>收藏总数</span><b>${stats.total}</b><small>部作品</small></div><div class="metric-card"><span>首播跨度</span><b>${yearSpan}</b><small>${knownYears.length} 部有年份资料</small></div><div class="metric-card"><span>平均评分</span><b>${stats.average === null ? '—' : stats.average.toFixed(1)}</b><small>5 分制 · ${stats.rated} / ${stats.total} 部已评</small></div></div><div class="distribution-grid"><section class="distribution-panel"><h3>类型分布</h3>${bars(stats.types, TYPE)}</section><section class="distribution-panel decade-distribution"><h3>首播年代</h3>${decadeBars || '<div class="tool-empty compact">暂无年份资料</div>'}</section></div><div class="tool-section collection-recent"><div class="tool-section-head"><h3>首播动态</h3><span>${recent.length} 条</span></div><div class="collection-recent-list">${recent.length ? recent.map(item => `<button type="button" class="collection-recent-item" data-open="${esc(item.id)}"><span><b>${esc(item.title)}</b><small>${item.year || '年份未知'} · ${TYPE[item.type] || '作品'}${item.region ? ` · ${esc(item.region)}` : ''}</small></span><i>${esc(premiereText(item))}</i></button>`).join('') : '<div class="tool-empty">暂无记录</div>'}</div></div>`;
}
function compactTimelineGroups(groups) {
  const buckets = new Map();
  for (const [label, rows] of groups) {
    // Exact premiere dates remain sorted inside a month, while the month
    // heading prevents a large archive from becoming one very tall rail.
    const date = label.match(/^(\d{4})年(\d{1,2})月(?:\d{1,2}日)?$/);
    const bucket = date ? `${date[1]}年${date[2]}月` : label;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(...rows);
  }
  return [...buckets];
}
function renderTimeline() {
  // A collection timeline describes the works themselves. Local import or
  // edit timestamps are intentionally not exposed as alternate axes.
  timelineField = 'premiere';
  const timelineEntries = library.entries.map(item => ({item, year:premiereYear(item)}));
  const decades = [...new Set(timelineEntries.filter(({year}) => year !== null).map(({year}) => Math.floor(year / 10) * 10))].sort((a,b) => b-a);
  const hasUnknown = timelineEntries.some(({year}) => year === null);
  const decadeCounts = new Map(decades.map(decade => [decade, timelineEntries.filter(({year}) => year !== null && Math.floor(year / 10) * 10 === decade).length]));
  const filtered = timelineEntries.filter(({year}) => {
    if (!timelineDecade) return true;
    if (timelineDecade === 'unknown') return year === null;
    return year !== null && Math.floor(year / 10) * 10 === Number(timelineDecade);
  }).map(({item}) => item);
  const groups = compactTimelineGroups(timelineGroups(filtered,timelineField));
  const total = groups.reduce((count, [, rows]) => count + rows.length, 0);
  const known = timelineEntries.length - timelineEntries.filter(({year}) => year === null).length;
  const nextKey = `${timelineField}|${timelineDecade}|${library.revision}|${library.entries.length}`;
  if (nextKey !== timelineKey) { timelineKey = nextKey; timelineShown = 120; }
  let remaining = timelineShown;
  const visibleGroups = groups.map(([date, rows]) => {
    if (remaining <= 0) return null;
    const visible = rows.slice(0, remaining);
    remaining -= visible.length;
    return [date, visible];
  }).filter(Boolean);
  const visibleCount = Math.min(total, timelineShown);
  const more = visibleCount < total ? `<div class="timeline-more"><button type="button" class="text-btn" id="timelineMore">继续加载 · ${visibleCount} / ${total}</button></div>` : '';
  const decadeNav = `<div class="timeline-decades" role="group" aria-label="按首播年代筛选"><button type="button" class="timeline-decade ${!timelineDecade?'active':''}" data-timeline-decade="" aria-pressed="${!timelineDecade}"><span>全部</span><b>${library.entries.length}</b></button>${decades.map(decade => `<button type="button" class="timeline-decade ${timelineDecade===String(decade)?'active':''}" data-timeline-decade="${decade}" aria-pressed="${timelineDecade===String(decade)}"><span>${decade}年代</span><b>${decadeCounts.get(decade)}</b></button>`).join('')}${hasUnknown ? `<button type="button" class="timeline-decade ${timelineDecade==='unknown'?'active':''}" data-timeline-decade="unknown" aria-pressed="${timelineDecade==='unknown'}"><span>日期未知</span><b>${library.entries.length-known}</b></button>` : ''}</div>`;
  const summary = timelineDecade ? `${total} 部作品` : `${known} 部有首播资料${hasUnknown ? ` · ${library.entries.length-known} 部日期未知` : ''}`;
  $('toolTimeline').innerHTML = `<div class="tool-section-head timeline-head"><span class="timeline-title">首播时间</span><span class="timeline-subtitle">${summary}</span></div>${decadeNav}`+(groups.length ? `<div class="timeline">${visibleGroups.map(([date,rows]) => `<section class="timeline-day"><header><time>${esc(date)}</time><span>${rows.length} 部</span></header><div>${rows.map(x => `<button class="timeline-item" data-tool-open="${esc(x.id)}"><i aria-hidden="true"></i><span class="timeline-item-copy"><b>${esc(x.title)}</b><small>${esc(TYPE[x.type] || '作品')}${x.region ? ` · ${esc(x.region)}` : ''}</small></span><time class="timeline-item-date">${esc(premiereDetail(x))}</time></button>`).join('')}</div></section>`).join('')}</div>${more}` : '<div class="tool-empty">暂无时间记录</div>');
}
function catalogOptions(field, values, labels = values) {
  const title = ({year:'年份',season:'季度',region:'地区',list:'列表',type:'类型'})[field];
  const scrollClass = values.length > 12 ? ' is-scrollable' : '';
  return `<div class="catalog-options${scrollClass}" data-catalog-options="${field}" role="group" aria-label="按${title}筛选"><button type="button" class="catalog-option ${!catalogFilters[field]?'active':''}" data-catalog-filter="${field}" data-value="" aria-pressed="${!catalogFilters[field]}">全部${title}</button>${values.map((v,i)=>`<button type="button" class="catalog-option ${catalogFilters[field]===v?'active':''}" data-catalog-filter="${field}" data-value="${esc(v)}" aria-pressed="${catalogFilters[field]===v}">${esc(labels[i] || v)}</button>`).join('')}</div>`;
}
function renderCatalog() {
  const years = [...new Set(library.entries.map(x => x.year).filter(Boolean))].sort((a,b)=>b-a).map(String);
  const commonRegions = ['中国','日本','美国'];
  const regions = [...new Set([...commonRegions, ...library.entries.map(x => x.region).filter(Boolean)])].sort((a,b) => {
    const ai = commonRegions.indexOf(a), bi = commonRegions.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? commonRegions.length : ai) - (bi < 0 ? commonRegions.length : bi);
    return a.localeCompare(b,'zh');
  });
  const lists = uiPreferences().lists.filter(list => list.kind !== 'all');
  if (catalogFilters.list && !lists.some(list => list.id === catalogFilters.list)) catalogFilters.list = '';
  const selectedList = lists.find(list => list.id === catalogFilters.list);
  const filtered = library.entries.filter(x => (!catalogFilters.year || String(x.year)===catalogFilters.year) && (!catalogFilters.season || x.season===catalogFilters.season) && (!catalogFilters.region || x.region===catalogFilters.region) && (!selectedList || (selectedList.kind === 'status' ? x.status===selectedList.status : x.lists.includes(selectedList.id))) && (!catalogFilters.type || x.type===catalogFilters.type));
  const visible = filtered.slice(0, catalogShown);
  const more = visible.length < filtered.length ? `<div class="catalog-more"><button type="button" class="text-btn" id="catalogMore">继续加载 · ${visible.length} / ${filtered.length}</button></div>` : '';
  const activeCount = Object.values(catalogFilters).filter(Boolean).length;
  const reset = activeCount ? `<button type="button" class="text-btn" data-catalog-reset>清除 ${activeCount} 项</button>` : '';
  $('toolCatalog').innerHTML = `<div class="catalog-filters"><div class="catalog-filter-top"><b>筛选</b>${reset}</div><div class="catalog-filter-group"><span>年份</span>${catalogOptions('year',years)}</div><div class="catalog-filter-group"><span>季度</span>${catalogOptions('season',['冬','春','夏','秋'])}</div><div class="catalog-filter-group"><span>地区</span>${catalogOptions('region',regions)}</div><div class="catalog-filter-group"><span>列表</span>${catalogOptions('list',lists.map(list=>list.id),lists.map(list=>list.label))}</div><div class="catalog-filter-group"><span>类型</span>${catalogOptions('type',['anime','movie','tv'],['动画','电影','剧集'])}</div></div><div class="catalog-result-head"><b>${filtered.length} 部作品</b></div><div class="catalog-list">${visible.length ? visible.map(toolCard).join('') : '<div class="tool-empty">没有匹配作品</div>'}</div>${more}`;
}
const WEEKDAYS = ['周一','周二','周三','周四','周五','周六','周日'];
function seasonCard(item) {
  const broadcast = item.broadcastTime || item.broadcastLabel || '';
  const broadcastLabel = item.broadcastDay ? broadcast.replace(/周[一二三四五六日]/g, '').replace(/\s{2,}/g, ' ').trim() : broadcast;
  const schedule = [item.broadcastDay?WEEKDAYS[item.broadcastDay-1]:'',broadcastLabel,item.broadcastTimezone==='Asia/Tokyo'?'日本时间':item.broadcastTimezone].filter(Boolean).join(' · ');
  // Episode totals remain detail-only. Seasonal indexes often revise them
  // late, so the schedule view must not promote a provisional count.
  const info = [item.format,item.airedAt?new Date(item.airedAt).toLocaleDateString('zh-CN',{timeZone:item.broadcastTimezone==='Asia/Tokyo'?'Asia/Tokyo':'UTC'})+' 首播':''].filter(Boolean).join(' · ');
  return `<button class="tool-work season-work" data-tool-open="${esc(item.id)}"><div class="tool-work-cover">${picture(item,'mini-cover')}</div><div><b>${esc(item.title)}</b>${item.originalTitle&&item.originalTitle!==item.title?`<span>${esc(item.originalTitle)}</span>`:''}${info?`<span>${esc(info)}</span>`:''}${schedule?`<span class="broadcast-label">${esc(schedule)}</span>`:''}${item.studios.length?`<span>${esc(item.studios.join(' / '))}</span>`:''}</div></button>`;
}
function renderSeason() {
  const root = $('toolSeason'), focused = document.activeElement;
  const restoreFocus = root.contains(focused);
  const focusAttribute = ['data-season-year','data-season-quarter','data-season-day'].find(name => focused?.hasAttribute(name));
  const focusSelector = focusAttribute ? `[${focusAttribute}="${CSS.escape(focused.getAttribute(focusAttribute))}"]` : focused?.id ? `#${CSS.escape(focused.id)}` : '';
  const yearScroll = root.querySelector('.season-year-options')?.scrollLeft || 0;
  const {year,season}=seasonQuery;
  const years = Array.from({length:YUC_SEASON_MAX_YEAR - YUC_SEASON_MIN_YEAR + 1}, (_,index) => YUC_SEASON_MAX_YEAR - index);
  // The quarter workspace has one deliberate product source: Yuc's public
  // schedule index. The server keeps JSON providers for compatibility and
  // diagnostics, but exposing those fallback names here would imply that
  // this page is a mixed or local catalogue.
  const sourceLabel='Yuc · 长门番堂';
  const visible = seasonItems.filter(x=>!seasonDay || (seasonDay==='unknown'?!x.broadcastDay:x.broadcastDay===Number(seasonDay)));
  const cacheState = ['使用缓存数据','离线缓存'].includes(seasonError) ? seasonError : '';
  const countState = seasonLoading && !seasonItems.length ? '读取中' : `${seasonItems.length}${seasonTotal?' / '+seasonTotal:''} 部`;
  const sourceMeta = [countState,sourceLabel,seasonFetched?`更新于 ${new Date(seasonFetched).toLocaleDateString('zh-CN')}`:'',seasonLoading&&seasonItems.length?'更新中':cacheState].filter(Boolean).join(' · ');
  const visibleError = cacheState ? '' : seasonError;
  const failureState = visibleError && !seasonLoading
    ? seasonItems.length
      ? `<div class="season-inline-state" role="status"><span aria-hidden="true"></span><div><b>${seasonFailureKind==='more'?'后续内容未能读取':'目录更新未完成'}</b><small>已保留 ${seasonItems.length} 部作品与当前筛选${seasonFailureKind==='more'?'，可重试加载更多':'，可再次刷新'}。</small></div></div>`
      : `<div class="season-failure-state" role="status"><span class="season-failure-mark" aria-hidden="true">YUC</span><div><b>季度目录暂不可用</b><p>${esc(visibleError)}。收藏与本地资料不受影响。</p></div><button type="button" class="text-btn" id="retrySeason">重新读取</button></div>`
    : '';
  $('toolSeason').innerHTML = `<div class="season-head"><h3>${year} · ${season}季</h3><span>${esc(sourceMeta)}</span><button class="text-btn" id="loadSeason" ${seasonLoading?'disabled':''}>${seasonLoading?'读取中…':'刷新'}</button></div>
    <div class="season-filters"><div class="season-filter-row"><span>年份</span><div class="season-year-options" role="group" aria-label="选择年份">${years.map(value=>`<button type="button" class="season-year" data-season-year="${value}" aria-pressed="${value===year}">${value}</button>`).join('')}</div></div><div class="season-filter-row"><span>季度</span><div class="choice-pills" role="group" aria-label="选择季度">${YUC_SEASONS.map(s=>{ const available=isYucQuarterAvailable(year,s); return `<button type="button" class="choice-pill" data-season-quarter="${s}" aria-pressed="${s===season}" ${available?'':'disabled aria-disabled="true"'}>${s}</button>`; }).join('')}</div></div></div>
    ${failureState}
    ${seasonItems.length?`<div class="weekday-filter" role="group" aria-label="播出日">${[['','全周'],...WEEKDAYS.map((label,i)=>[String(i+1),label]),['unknown','未定']].map(([value,label])=>`<button class="text-btn" data-season-day="${value}" aria-pressed="${seasonDay===value}">${label}</button>`).join('')}</div>`:''}
    <div class="season-grid">${visible.length ? visible.map(seasonCard).join('') : visibleError && !seasonLoading && !seasonItems.length ? '' : `<div class="tool-empty">${seasonLoading&&!seasonItems.length?'加载中…':seasonDay?'已加载作品中暂无匹配':'暂无作品'}${seasonDay&&seasonItems.length?'<button type="button" class="text-btn" data-season-day="">查看全周</button>':''}</div>`}</div>
    ${seasonHasNext?`<button class="text-btn season-more" id="moreSeason" ${seasonLoading?'disabled':''}>${visibleError&&seasonFailureKind==='more'?'重试加载更多':'加载更多'}</button>`:''}`;
  root.querySelector('.season-year-options').scrollLeft = yearScroll;
  if (restoreFocus) {
    const nextFocus = focusSelector && root.querySelector(focusSelector);
    if (nextFocus && !nextFocus.disabled) nextFocus.focus({preventScroll:true});
    else {
      const heading = root.querySelector('.season-head h3');
      heading.tabIndex = -1; heading.focus({preventScroll:true});
    }
  }
}
function currentSeason() {
  const now = new Date();
  return { year: now.getFullYear(), season: ['冬','春','夏','秋'][Math.floor(now.getMonth() / 3)] };
}
function searchSeasonCard(item) {
  const info = [item.format, item.region, item.studios?.[0]].filter(Boolean).slice(0, 2).join(' · ') || '动画';
  return `<button type="button" class="search-season-item" data-tool-open="${esc(item.id)}"><div>${picture(item,'mini-cover')}</div><div><b>${esc(item.title)}</b>${item.originalTitle && item.originalTitle !== item.title ? `<span>${esc(item.originalTitle)}</span>` : ''}<span>${esc(info)}</span></div></button>`;
}
function renderSearchSeason() {
  const root = $('searchSeasonPreview');
  if (!root) return;
  const sourcesPending = Object.values(sourceResults).some(source => source?.state === 'loading');
  const sourcesFailed = Object.values(sourceResults).some(source => ['unavailable','stale'].includes(source?.state));
  // The seasonal shelf is a calm empty state: it steps aside as soon as a
  // search has actual matches, and returns for a query that found nothing.
  if (searchQuery && (searchWaiting || results.length || sourcesPending || sourcesFailed)) { root.hidden = true; root.innerHTML = ''; return; }
  root.hidden = false;
  const q = currentSeason();
  const sourceLabel = 'Yuc · 长门番堂';
  const usingCache = ['使用缓存数据','离线缓存'].includes(searchSeasonError);
  const sourceState = searchSeasonLoading && searchSeasonItems.length ? `${sourceLabel} · 更新中…` : usingCache ? `${sourceLabel} · ${searchSeasonError}` : searchSeasonError ? `${sourceLabel} · 暂不可用` : sourceLabel;
  const stamp = searchSeasonFetched ? ` · 更新于 ${new Date(searchSeasonFetched).toLocaleDateString('zh-CN')}` : '';
  const state = searchSeasonLoading && !searchSeasonItems.length ? '<div class="search-season-state">读取当季目录…</div>' : searchSeasonItems.length ? searchSeasonItems.slice(0, 12).map(searchSeasonCard).join('') : `<div class="search-season-state">${esc(searchSeasonError || '暂无当季作品')}${searchSeasonError && searchSeasonError !== '使用缓存数据' ? '<button type="button" class="text-btn search-season-retry" data-search-season-retry>重试</button>' : ''}</div>`;
  root.innerHTML = `<div class="search-season-head"><div><h2 id="searchSeasonTitle">当季新番</h2><span>${q.year} · ${q.season}季${stamp}</span></div><span class="search-season-source">${searchSeasonLoading ? '读取中…' : esc(sourceState)}</span></div><div class="search-season-grid">${state}</div>`;
}
async function loadSearchSeason() {
  if (searchSeasonLoaded || searchSeasonLoading) return;
  const { year, season } = currentSeason();
  const cached = readSeasonCache(year, season, 1);
  if (cached) {
    searchSeasonItems = cachedSeasonEntries(cached, year, season, true);
    searchSeasonFetched = cached.fetchedAt || '';
    searchSeasonSource = cached.source || 'yuc';
    searchSeasonError = searchSeasonItems.length ? '使用缓存数据' : '';
  } else {
    searchSeasonItems = [];
    searchSeasonFetched = '';
    searchSeasonSource = '';
    searchSeasonError = '';
  }
  searchSeasonLoading = true; renderSearchSeason();
  const request = new AbortController();
  searchSeasonAbort?.abort();
  searchSeasonAbort = request;
  // The seasonal shelf follows Yuc's Chinese release index.  It is a
  // separate remote catalogue, not a projection of the local collection and
  // not a blend with keyword-search providers.
  const preferred = 'yuc';
  try {
    const data = await api(`/api/catalog/season?year=${year}&season=${encodeURIComponent(season)}&page=1&source=${preferred}`, { signal: request.signal });
    if (searchSeasonAbort !== request) return;
    const items = (data.results || []).map(entry).filter(x => x.type === 'anime' && x.year === year && x.season === season && (data.source !== 'yuc' || x.seasonNew));
    searchSeasonItems = [...new Map(items.map(x => [x.id, x])).values()];
    searchSeasonFetched = data.fetchedAt || '';
    searchSeasonSource = data.source || '';
    searchSeasonError = data.state === 'stale' ? '使用缓存数据' : '';
    writeSeasonCache(year, season, 1, data);
  } catch {
    if (searchSeasonAbort !== request) return;
    const cached = readSeasonCache(year, season, 1);
    if (cached) {
      searchSeasonItems = cachedSeasonEntries(cached, year, season, cached.source === 'yuc');
      searchSeasonFetched = cached.fetchedAt || '';
      searchSeasonSource = cached.source || '';
      searchSeasonError = '离线缓存';
    } else {
      searchSeasonItems = [];
      searchSeasonError = '远程当季目录暂不可用';
    }
  } finally {
    if (searchSeasonAbort !== request) return;
    searchSeasonAbort = null;
    searchSeasonLoading = false; searchSeasonLoaded = true; renderSearchSeason();
  }
}
function useRemoteSeasonUnavailable(message = '远程季度目录暂不可用') {
  // The quarter browser is intentionally a network catalogue. Do not make a
  // local collection look like a complete seasonal listing when an upstream
  // source is down; keep the empty state honest and leave refresh available.
  seasonItems = [];
  seasonPage = 1;
  seasonHasNext = false;
  seasonTotal = null;
  seasonFetched = '';
  seasonSource = '';
  seasonError = message;
  seasonFailureKind = 'load';
  seasonLoaded = true;
}
async function loadSeason(more=false) {
  if(seasonLoading)return;
  // Keep quarter browsing on the fixed Yuc catalogue.  JSON providers remain
  // available for keyword search, but mixing them here changes the scope and
  // can make the page look like a local or unrelated seasonal list.
  const preferred = 'yuc';
  const requestPage=more?seasonPage+1:1, version=++seasonVersion;
  // A refresh keeps the complete in-memory catalogue visible until a new
  // first page succeeds. Reading just page one from disk here would discard
  // already loaded later pages even when the refresh subsequently fails.
  const hasLoadedItems = seasonItems.length > 0;
  seasonFailureKind = '';
  if (!more && !hasLoadedItems) {
    const cached = readSeasonCache(seasonQuery.year, seasonQuery.season, 1);
    if (cached) {
      seasonItems = cachedSeasonEntries(cached, seasonQuery.year, seasonQuery.season);
      seasonPage = 1;
      seasonHasNext = cached.hasNext === true;
      seasonFetched = cached.fetchedAt || '';
      seasonTotal = cached.total || seasonItems.length || null;
      seasonSource = cached.source || 'yuc';
      seasonError = seasonItems.length ? '使用缓存数据' : '';
    } else {
      seasonItems = [];
      seasonPage = 0;
      seasonHasNext = false;
      seasonFetched = '';
      seasonTotal = null;
      seasonSource = '';
      seasonError = '';
    }
  } else seasonError = '';
  seasonLoading=true;renderSeason();
  const request = new AbortController();
  seasonAbort?.abort();
  seasonAbort = request;
 try {
    const data=await api(`/api/catalog/season?year=${seasonQuery.year}&season=${encodeURIComponent(seasonQuery.season)}&page=${requestPage}&source=${preferred}`, { signal: request.signal });
    if (seasonAbort !== request) return;
    if(version!==seasonVersion)return;
    const items=(data.results||[]).map(entry);
    seasonItems=[...new Map([...(more?seasonItems:[]),...items].map(x=>[x.id,x])).values()];
    seasonPage=requestPage;seasonHasNext=data.hasNext===true;seasonFetched=data.fetchedAt||'';seasonTotal=data.total||null;seasonSource=data.source||seasonSource;
    seasonError=data.state==='stale'?'离线缓存':'';seasonLoaded=true;
    writeSeasonCache(seasonQuery.year, seasonQuery.season, requestPage, data);
  } catch(error) {
    if (seasonAbort !== request) return;
    if (version === seasonVersion) {
      if (more && seasonItems.length) {
        // Keep the pages already on screen when a later page is interrupted;
        // the user can retry without losing their current browsing position.
        seasonError = '更多远程内容暂不可用';
        seasonFailureKind = 'more';
        seasonLoaded = true;
      } else if (hasLoadedItems) {
        seasonError = '季度目录更新暂不可用';
        seasonFailureKind = 'refresh';
        seasonLoaded = true;
      } else {
        const cached = readSeasonCache(seasonQuery.year, seasonQuery.season, requestPage);
        if (cached) {
          const cachedItems = (cached.results || []).map(entry);
          seasonItems = [...new Map([...(more ? seasonItems : []), ...cachedItems].map(x => [x.id, x])).values()];
          seasonPage = requestPage;
          seasonHasNext = cached.hasNext === true;
          seasonFetched = cached.fetchedAt || '';
          seasonTotal = cached.total || null;
          seasonSource = cached.source || '';
          seasonError = '离线缓存';
          seasonLoaded = true;
        } else useRemoteSeasonUnavailable('远程季度目录暂不可用');
      }
    }
  }
  finally {
    if (seasonAbort !== request) return;
    seasonAbort = null;
    if(version===seasonVersion){seasonLoading=false;renderSeason();}
  }
}
function metaText(item, prefs) {
  const bits = [];
  const exactPremiere = Number.isFinite(Date.parse(item.airedAt || ''));
  const premiere = exactPremiere ? premiereStamp(item) : 0;
  if (prefs.display.year) {
    if (prefs.time === 'date' && premiere) bits.push(new Date(premiere).toLocaleDateString('zh-CN', { timeZone:'UTC' }));
    else if (prefs.time === 'relative' && premiere) {
      const days = Math.floor((Date.now() - premiere) / 86400000);
      bits.push(days < 0 ? `${Math.abs(days)} 天后首播` : days ? `${days} 天前首播` : '今天首播');
    } else bits.push(item.year ? `${item.year}${item.season ? ` · ${item.season}季` : ''}` : '首播未知');
  }
  if (prefs.display.type) bits.push(TYPE[item.type]);
  if (prefs.display.rating && item.score) bits.push(`${detailSourceLabel(item)} ${item.score.toFixed(1)}`);
  // Episode totals and current progress are intentionally detail-only: source
  // totals can be provisional, and the collection canvas should stay calm.
  return bits.join(' · ') || '打开查看详情';
}
function unitText(item) { return item.type === 'movie' ? '部' : '集'; }
function selectedEntries() {
  const valid = new Set(library.entries.map(x => x.id));
  for (const id of selectedIds) if (!valid.has(id)) selectedIds.delete(id);
  return library.entries.filter(x => selectedIds.has(x.id));
}
function renderBatchToolbar() {
  const toolbar = $('batchToolbar');
  if (!toolbar) return;
  toolbar.hidden = !selectionMode;
  const selected = selectedEntries();
  $('batchCount').textContent = `已选 ${selected.length} 部`;
  const visibleInputs = [...document.querySelectorAll('[data-select]')];
  const allVisibleSelected = visibleInputs.length > 0 && visibleInputs.every(input => selectedIds.has(input.dataset.select));
  const selectVisible = $('batchSelectVisible');
  selectVisible.disabled = visibleInputs.length === 0;
  selectVisible.textContent = allVisibleSelected ? '取消当前页' : '全选当前页';
  selectVisible.setAttribute('aria-pressed', String(allVisibleSelected));
  const listSelect = $('batchListSelect');
  const currentList = listSelect.value;
  const entryLists = uiPreferences().lists.filter(x => x.kind !== 'all');
  listSelect.innerHTML = '<option value="">选择目标列表</option>' + entryLists.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
  listSelect.value = entryLists.some(x => x.id === currentList) ? currentList : '';
  const target = entryLists.find(x => x.id === listSelect.value);
  const batchAction = $('batchAddList');
  batchAction.disabled = !selected.length || !target;
  batchAction.textContent = target ? (target.kind === 'status' ? `移至${target.label}` : `加入${target.label}`) : '应用';
  $('toggleSelection').textContent = selectionMode ? '完成' : '选择';
  $('toggleSelection').setAttribute('aria-pressed', String(selectionMode));
}
function toggleSelectionMode() {
  selectionMode = !selectionMode;
  if (!selectionMode) selectedIds.clear();
  render();
}
function clearSelection() {
  selectedIds.clear();
  renderBatchToolbar();
  document.querySelectorAll('[data-select]').forEach(input => { input.checked = false; input.closest('.poster-card')?.classList.remove('selected'); });
}
function toggleVisibleSelection() {
  const inputs = [...document.querySelectorAll('[data-select]')];
  const shouldSelect = inputs.some(input => !selectedIds.has(input.dataset.select));
  for (const input of inputs) {
    if (shouldSelect) selectedIds.add(input.dataset.select); else selectedIds.delete(input.dataset.select);
    input.checked = shouldSelect;
    input.closest('.poster-card')?.classList.toggle('selected', shouldSelect);
  }
  renderBatchToolbar();
}

async function api(path, options = {}) {
  const timeout = AbortSignal.timeout(12000);
  const r = await fetch(path, { ...options, headers: { 'X-Yingjian':'1', ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers }, signal: options.signal ? AbortSignal.any([options.signal,timeout]) : timeout });
  const data = await r.json();
  if (!r.ok) {if(data.draftRecovery)queueMicrotask(reportEntryDraftRecovery);throw Object.assign(Error(data.error || `请求失败 (${r.status})`),{status:r.status,migrationPending:data.migrationPending===true,draftRecovery:data.draftRecovery===true});}
  return data;
}
function errorMessage(error, fallback = '操作未完成，请稍后重试') {
  if (error?.name === 'AbortError') return '请求已取消';
  if (error?.name === 'TimeoutError') return '请求超时，请稍后重试';
  const message = String(error?.message || '').trim();
  if (!message || /failed to fetch|network\s*error|network request failed|load failed/i.test(message)) return '网络连接失败，请稍后重试';
  return message;
}
async function loadAbout() {
  const renderInfo = info => {
    $('aboutVersion').textContent = info?.version || '—';
    $('aboutEdition').textContent=info?.desktop?'桌面版':'本地版';
    const path = info?.dataDirectory || '本机存储';
    $('aboutDataPath').textContent = path;
    $('aboutDataPath').title = info?.dataDirectory || '';
    $('openDataFolder').textContent = info?.fileManager ? (info.fileManager === 'Finder' ? '在 Finder 中打开' : `在${info.fileManager}中打开`) : '打开数据目录';
  };
  if (appInfo) { renderInfo(appInfo); return; }
  if (!appInfoPromise) appInfoPromise = api('/api/app-info').then(info => (appInfo=info)).catch(() => null).finally(() => { appInfoPromise=null; });
  renderInfo(await appInfoPromise);
}
async function openDataFolder() {
  const button = $('openDataFolder');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api('/api/data-folder', { method:'POST' });
    toast(`已在${result.label || '文件管理器'}中打开数据目录。`);
  } catch (e) {
    toast(`无法打开数据目录：${errorMessage(e)}`);
  } finally {
    button.disabled = false;
  }
}
function notificationFallback(){
  const target=activeDialog?$(activeDialog).querySelector('.close-btn'):current?$('closeDrawer'):$(workspace==='search'?'searchTitle':workspace==='sources'?'sourcePageTitle':workspace==='tools'?'toolsPageTitle':'sectionTitle');
  if(target?.matches('h1,h2'))target.tabIndex=-1;
  return target;
}
function drawNotices(items){
  const region=$('toasts'),focused=document.activeElement,hadFocus=region.contains(focused),wanted=new Set(items.map(item=>item.id));
  for(const node of [...region.children])if(!wanted.has(node.dataset.noticeId))node.remove();
  for(const item of items){
    let row=[...region.children].find(node=>node.dataset.noticeId===item.id);
    if(!row){row=document.createElement('div');row.className='toast';row.tabIndex=-1;row.dataset.noticeId=item.id;row.innerHTML='<div class="toast-copy"><span class="toast-message"></span><p class="toast-error" hidden></p></div><button type="button" class="toast-action" hidden></button><button type="button" class="toast-dismiss" aria-label="关闭提示">×</button>';region.append(row);}
    row.dataset.toastMessage=item.message;if(item.label)row.dataset.toastAction='true';else delete row.dataset.toastAction;
    row.querySelector('.toast-message').textContent=item.message;
    const error=row.querySelector('.toast-error');error.textContent=item.error;error.hidden=!item.error;
    row.setAttribute('aria-busy',String(item.busy));
    const button=row.querySelector('.toast-action');button.hidden=!item.label;button.disabled=item.busy||item.blocked||item.unavailable;button.textContent=item.busy?'处理中…':item.unavailable?`不可${item.label}`:item.error?item.retryLabel||`重试${item.label}`:item.label;
    row.dataset.persistent=String(item.persistent);row.querySelector('.toast-dismiss').hidden=item.persistent;row.querySelector('.toast-dismiss').disabled=item.busy;
  }
  if(hadFocus&&!focused.isConnected){const next=region.querySelector('button:not(:disabled):not([hidden])')||notificationFallback();next?.focus({preventScroll:true});}
}
const notices=createNotices({change:drawNotices,announce:message=>{$('toastAnnouncements').textContent=message;},errorText:errorMessage});
function queueEditRecovery(task){
  const result=editRecoveryTail.then(task);
  editRecoveryTail=result.catch(error=>{editRecoveryError=`恢复记录未能写入：${errorMessage(error)}`;renderEntryRecovery();toast(editRecoveryError,{label:'检查恢复',allowWhileBlocked:true,run:()=>showEditRecoveryRepair()});});
  return result;
}
function rememberEdit(kind,target,value,label,logicalTarget=target){
  const key=`${kind}:${logicalTarget}`;let record=editDrafts.get(key);
  if(!record){record={id:crypto.randomUUID(),kind,target,persistedVersion:null};editDrafts.set(key,record);}
  const version=crypto.randomUUID(),snapshot={id:record.id,kind,target,version,value:structuredClone(value),label:String(label||target).slice(0,200),updatedAt:new Date().toISOString()};
  record.version=version;record.value=structuredClone(value);
  void queueEditRecovery(async()=>{
    if(!editRecovery)await initializeEditRecovery();
    const saved=await editRecovery.writeDraft(snapshot,record.persistedVersion);record.persistedVersion=saved.version;editRecoveryError='';renderEntryRecovery();
  });
  return version;
}
async function forgetEdit(kind,target,version){
  const key=`${kind}:${target}`,record=editDrafts.get(key);
  if(!record||record.version!==version)return;
  await queueEditRecovery(async()=>{
    if(record.version!==version)return;
    if(await editRecovery.forgetDraft(record.id,version)){
      editDrafts.delete(key);editRecoverableRecords=editRecoverableRecords.filter(item=>item.id!==record.id);renderEntryRecovery();
    }
  }).catch(()=>{});
}
async function initializeEditRecovery(){
  await loadAbout();if(!appInfo?.dataDirectory)throw Error('无法确认当前数据目录，未提交编辑恢复');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(appInfo.dataDirectory));
  const scope=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  editRecovery ||= createEditRecovery({name:'fandu-edit-recovery-v1-'+scope});
  const records=await editRecovery.read();editRecoveryError='';
  editRecoverableRecords=records.filter(item=>item.kind!=='intent');renderEntryRecovery();
  return records.filter(item=>item.kind==='intent');
}
async function resumeEditDraft(id){
  if(saving||saveCoordinator.unconfirmed)return toast('请先完成或核对当前保存。');
  const stored=(await editRecovery.read()).find(item=>item.id===id&&item.kind!=='intent');
  if(!stored)throw Error('这份草稿已处理，请重新读取');
  if(stored.kind==='command'){
    if(stored.value.binding){
      const binding=stored.value.binding,result=await api('/api/library/save-status?id='+encodeURIComponent(binding.requestId));
      if(result.state!=='completed'||result.requestId!==binding.requestId||result.fingerprint!==binding.fingerprint||result.revision!==binding.revision+1||!Number.isSafeInteger(result.library?.revision)||result.library.revision<result.revision||!result.library.settings||typeof result.library.settings!=='object'||Array.isArray(result.library.settings))throw Error('这次操作的结果暂时无法核对，未再次执行。可导出记录，检查当前资料后决定是否放弃。');
      validateLibrary(result.library.entries);
      if(!await editRecovery.forgetDraft(stored.id,stored.version))throw Error('操作记录已变化，请重新读取');
      library=result.library;editRecoverableRecords=editRecoverableRecords.filter(item=>item.id!==stored.id);renderEntryRecovery();render();toast('这次操作已完成，未再次执行。');return;
    }
    const logicalKey=stored.id;
    editDrafts.set(`command:${logicalKey}`,{id:stored.id,kind:stored.kind,target:stored.target,version:stored.version,persistedVersion:stored.version,value:stored.value});
    if(await commitCommand(stored.value.command,'',{logicalKey})){if(activeDialog==='dataDialog')loadSettings();if(current&&!library.entries.some(item=>item.id===current.id))await closeDetail();}
    $('entryRecoveryMenu').open=false;return;
  }
  const latest=library.entries.find(item=>item.id===stored.target);
  if(['note','form','fields'].includes(stored.kind)&&!latest)throw Error('作品已不在收藏中，未重新添加。可导出草稿保留输入。');
  if(stored.kind==='manager'&&!uiPreferences()[stored.value.kind==='list'?'lists':'series'].some(item=>item.id===stored.value.id))throw Error('项目已不存在，未重新创建。可导出草稿保留名称。');
  editDrafts.set(`${stored.kind}:${stored.target}`,{id:stored.id,kind:stored.kind,target:stored.target,version:stored.version,persistedVersion:stored.version});
  if(stored.kind==='note'){
    await openDetail(latest);$('noteInput').value=stored.value.value;dirty=true;queueNoteEdit(stored.value.value);$('noteInput').focus();
  }else if(stored.kind==='form'){
    await openForm(latest);
    const draft=stored.value;
    for(const field of draft.changedFields){
      if(field==='tags')renderEntryTagPicker(parseTags(draft.values.tags));
      else if(field==='lists')$('listMembership').querySelectorAll('[data-entry-list-kind=custom]').forEach(input=>input.checked=draft.lists.includes(input.value));
      else if(field==='seriesId')setEntrySeries(uiPreferences().series.some(item=>item.id===draft.values.seriesId)?draft.values.seriesId:'');
      else if($('entryForm').elements[field])$('entryForm').elements[field].value=draft.values[field];
    }
    if(draft.changedFields.includes('status'))$('listMembership').querySelectorAll('[data-entry-list-kind=status]').forEach(input=>input.checked=input.dataset.entryListStatus===draft.values.status);
    ['entryType','entryStatus','entrySeason','entryRegion'].forEach(syncChoiceGroup);
    entryChangedFields=new Set(draft.changedFields);entryObservedDraft=captureEntryDraft();queueEntryEdit();
    $('entryForm').elements.title.focus();
  }else if(stored.kind==='fields'){
    await openDetail(latest);
    const patch={...stored.value.patch};
    if(patch.lists)patch.lists=patch.lists.filter(id=>uiPreferences().lists.some(item=>item.kind==='custom'&&item.id===id));
    const ok=await updateSavedEntry(latest.id,item=>applyRecoveredFields(item,{patch,action:stored.value.action}));
    if(ok){await editRecovery.forgetDraft(stored.id,stored.version);editDrafts.delete(`fields:${stored.target}`);editRecoverableRecords=editRecoverableRecords.filter(item=>item.id!==stored.id);renderEntryRecovery();await openDetail(library.entries.find(item=>item.id===latest.id),false);}
  }else if(stored.kind==='settings'){
    settingsTab='general';loadSettings();await showDialog('dataDialog');savePreferences(stored.value);loadGeneralSettings();
  }else{
    const {kind,id:target,value}=stored.value;
    settingsTab=kind==='list'?'list':'series';loadSettings();await showDialog('dataDialog');
    const input=document.querySelector(`[data-${kind}-label="${CSS.escape(target)}"]`);input.value=value;queueManagerName(input);input.focus();
  }
  $('entryRecoveryMenu').open=false;
}
let saveRecoveryNotice=null;
const saveCoordinator=createSaveCoordinator({
  prepare:async payload=>{await editRecoveryTail;if(!editRecovery)await initializeEditRecovery();await editRecovery.prepare(payload,savingCommand?[savingCommand]:[]);},
  finish:async(payload,outcome)=>{const removed=await editRecovery.forgetIntent(payload,outcome);if(removed.length){editRecoverableRecords=editRecoverableRecords.filter(item=>!removed.includes(item.id));renderEntryRecovery();}},
  send:payload=>api('/api/library/save',{method:'POST',body:JSON.stringify(payload)}),
  confirm:id=>api('/api/library/save-status?id='+encodeURIComponent(id)),
  state:status=>{
    activeSaveRequestId=status.requestId;
    if(status.unconfirmed&&!saveRecoveryNotice){
      saveRecoveryNotice=notices.add(status.prepared?'保存结果待确认。当前输入仍保留，请核对后继续。':'编辑恢复未能写入。本次尚未提交，当前输入仍保留。',{label:status.prepared?'核对保存':'重试保存',retryLabel:'再次核对',persistent:true,allowWhileBlocked:true,run:async()=>{
        const outcome=await saveCoordinator.retry();if(outcome?.state==='pending')throw outcome.error||Error('暂时无法核对，请稍后重试');return true;
      }});
    }else if(!status.unconfirmed&&saveRecoveryNotice){notices.remove(saveRecoveryNotice);saveRecoveryNotice=null;}
    if(status.error?.code?.startsWith('FANDU_EDIT_RECOVERY_')){editRecoveryError=errorMessage(status.error);renderEntryRecovery();}
    if($('noteSaveState'))$('noteSaveState').textContent=noteStatusText();
    if(editId&&entryEditSaveStatus!=='error')$('entrySaveState').textContent=saveStatusLabel(entryEditSaveStatus);
    for(const id of ['generalSaveState','sourceSaveState'])if($(id))$(id).textContent=saveStatusLabel(settingsStatus);
    for(const record of managerNames.values())if(['pending','saving'].includes(record.status))updateManagerNameState(record,record.status);
    document.querySelectorAll('[data-resume-edit]').forEach(button=>button.disabled=status.unconfirmed||saving);
    syncBackupAvailability();syncEntryAddLock();syncDetailAddLock();
  }
});
function toast(message,action){return notices.add(message,action);}
function syncNoticeLocation(){
  const region=$('toasts'),focused=document.activeElement;
  const navigationOpen=matchMedia('(max-width:920px)').matches&&document.body.classList.contains('menu-open');
  const host=activeDialog?$(activeDialog).querySelector('.notice-slot'):current?$('detailNoticeSlot'):navigationOpen?$('navNoticeSlot'):$('toastHome');
  if(host&&region.parentElement!==host){host.append(region);if(region.contains(focused)&&!host.closest('[inert]'))focused.focus({preventScroll:true});}
  region.classList.toggle('notice-inline',Boolean(activeDialog||current||navigationOpen));
  const repair=$('editRecoveryRepair');
  if(repair&&!repair.hidden){const repairHost=activeDialog||current||navigationOpen?host:!loaded?$('posterGrid').querySelector('.load-error'):$('entryRecovery');if(repairHost&&repair.parentElement!==repairHost)repairHost.append(repair);}
  if(storageRecoveryInline){const pane=$('migrationRecovery'),target=activeDialog||current||navigationOpen?host:$('entryRecovery');if(target&&pane.parentElement!==target)target.append(pane);}
  // Reparenting a hovered/focused node does not reliably dispatch leave/out.
  // Reconcile with the actual active surface instead of retaining that pause.
  notices.pause('hover',region.matches(':hover'));
  notices.focus(region.contains(document.activeElement)?document.activeElement.closest('.toast')?.dataset.noticeId:null);
  syncNoticeBlocking();
}
async function showEditRecoveryRepair(){
  $('editRecoveryRepair').hidden=false;syncNoticeLocation();await inspectEditRecovery();$('exportEditRecovery').focus({preventScroll:true});
}
async function inspectEditRecovery(){
  if(repairBusy)return;repairBusy=true;editRepairSnapshot=null;$('discardBrokenEdits').hidden=true;
  try{
    if(!editRecovery)await initializeEditRecovery();
    editRepairSnapshot=await editRecovery.inspect();
    const {records,broken,newer}=editRepairSnapshot,eligible=broken.filter(item=>item.key!==`intent:${activeSaveRequestId}`);
    $('editRecoveryRepairState').textContent=`共 ${records.length} 条记录：${broken.length} 条损坏，${newer.length} 条需升级。正常记录与作品档案不会被清理。${broken.length!==eligible.length?'当前保存记录需先核对；无法核对时，请先导出并重新打开应用后处理。':''}`;
    $('editRecoveryRepairList').innerHTML=[...broken,...newer].map(item=>`<p><span>${esc(item.label)}</span><small>${esc(item.error)}</small></p>`).join('');
    $('discardBrokenEdits').hidden=!eligible.length;$('discardBrokenEdits').textContent=`仅放弃 ${eligible.length} 条损坏记录`;
  }catch(error){$('editRecoveryRepairState').textContent=`无法读取恢复记录：${errorMessage(error)}。未删除任何内容。`;$('editRecoveryRepairList').innerHTML='';}
  finally{repairBusy=false;}
}
$('repairEditRecovery').onclick=showEditRecoveryRepair;
$('inspectEditRecovery').onclick=inspectEditRecovery;
$('closeEditRecoveryRepair').onclick=()=>{$('editRecoveryRepair').hidden=true;renderEntryRecovery();notificationFallback()?.focus({preventScroll:true});};
$('exportEditRecovery').onclick=async()=>{try{if(!editRecovery)await initializeEditRecovery();const snapshot=await editRecovery.inspect();downloadJson({format:'fandu-edit-recovery-diagnostic-v1',...snapshot},`番渡恢复记录-${new Date().toISOString().slice(0,10)}.json`);$('editRecoveryRepairState').textContent='恢复记录已导出。清理损坏记录不会撤销已经完成的操作；可先检查当前资料。';}catch(error){$('editRecoveryRepairState').textContent=`导出失败：${errorMessage(error)}。原记录仍保留。`;}};
$('discardBrokenEdits').onclick=async()=>{
  if(repairBusy||!editRepairSnapshot)return;repairBusy=true;$('discardBrokenEdits').disabled=true;
  try{
    const removed=await editRecovery.discardBroken(editRepairSnapshot,{protectedKeys:[`intent:${activeSaveRequestId}`]});
    editRecoveryError='';editRepairSnapshot=null;$('discardBrokenEdits').hidden=true;
    if(loaded){try{editRecoverableRecords=(await editRecovery.read()).filter(item=>item.kind!=='intent'&&(item.kind==='command'||![...editDrafts.values()].some(owned=>owned.id===item.id)));}catch(error){editRecoveryError=errorMessage(error);}}
    renderEntryRecovery();
    $('editRecoveryRepairState').textContent=`已放弃 ${removed} 条损坏记录；正常记录与作品档案均保留。若已导出，可从导出文件查看原内容。`;
    if(!loaded){$('toastHome').append($('editRecoveryRepair'));$('editRecoveryRepair').hidden=true;await init();}
  }catch(error){$('editRecoveryRepairState').textContent=errorMessage(error);}
  finally{repairBusy=false;$('discardBrokenEdits').disabled=false;}
};
function syncNoticeBlocking(){notices.block(Boolean(saveCoordinator.unconfirmed||entryAdding||detailAdding||dataOperation||pendingDataResult()||entryDiscardOpen||formComposing||entryAddAttempt?.pending||detailAddAttempt?.pending));}
$('toasts').addEventListener('pointerenter',()=>notices.pause('hover',true));
$('toasts').addEventListener('pointerleave',()=>notices.pause('hover',false));
$('toasts').addEventListener('focusin',event=>notices.focus(event.target.closest('.toast')?.dataset.noticeId));
$('toasts').addEventListener('focusout',()=>queueMicrotask(()=>notices.focus($('toasts').contains(document.activeElement)?document.activeElement.closest('.toast')?.dataset.noticeId:null)));
$('toasts').addEventListener('click',async event=>{
  const button=event.target.closest('button'),row=button?.closest('.toast');if(!row||button.disabled)return;
  if(button.classList.contains('toast-dismiss')){notices.dismiss(row.dataset.noticeId);return;}
  const ownedFocus=button===document.activeElement;row.focus({preventScroll:true});await notices.run(row.dataset.noticeId);
  if(ownedFocus&&row.isConnected&&document.activeElement===row&&!button.disabled)button.focus({preventScroll:true});
});
document.addEventListener('visibilitychange',()=>notices.pause('background',document.hidden));
notices.pause('background',document.hidden);
// A stacked notice which needs scrolling should not disappear unread.
let noticeOverflow=false;
new ResizeObserver(()=>{
  const region=$('toasts'),overflow=region.scrollHeight>region.clientHeight+1;
  if(overflow!==noticeOverflow){noticeOverflow=overflow;notices.pause('overflow',overflow);}
}).observe($('toasts'));
function commit(entries, message, settings, options = {}) {
  const task = commitTail.then(() => persist(entries, message, settings, options));
  commitTail = task.catch(() => {}); return task;
}
async function commitCommand(value,message='',options={}){
  let command=libraryCommand(value);
  const logicalKey=options.logicalKey||(['create-list','create-series','create-tag'].includes(command.type)?`${command.type}:${normalizeText(command.label)}`:crypto.randomUUID());
  const previous=editDrafts.get(`command:${logicalKey}`);
  if(previous?.value?.command&&['create-list','create-series'].includes(command.type))command={...command,id:previous.value.command.id};
  const names={'batch-list':'批量加入列表','create-list':'创建列表','delete-list':'删除列表','move-list':'调整列表顺序','create-tag':'创建标签','delete-tag':'删除标签','create-series':'创建系列','delete-series':'删除系列','increment-progress':'增加进度','restart-entry':'从头重看','undo-restart':'撤销重看','remove-entry':'移出收藏','restore-entry':'恢复收藏'};
  const label=`${names[command.type]} · ${command.label||command.expectedLabel||library.entries.find(item=>item.id===command.id)?.title||''}`;
  const version=rememberEdit('command',command.type,{command},label,logicalKey),record=editDrafts.get(`command:${logicalKey}`);
  let applied;
  const ok=await commit(()=>{applied=applyLibraryCommand({...library,settings:uiPreferences()},command);options.onApplied?.(applied.effects);return applied.entries;},message,()=>applied.settings,{...options,commandRef:{id:record.id,version}});
  if(ok)await forgetEdit('command',logicalKey,version);
  else if(editRecovery){try{const stored=(await editRecovery.read()).find(item=>item.id===record.id);if(stored){editRecoverableRecords=[...editRecoverableRecords.filter(item=>item.id!==stored.id),stored];renderEntryRecovery();}}catch{/* Recovery error remains visible; do not discard the command. */}}
  return ok;
}
async function persist(entries, message, settings, {render:shouldRender = true,throwOnError = false,fixedPayload=null,commandRef=null} = {}) {
  if (!loaded) { toast('档案尚未读取，暂时不能保存。'); return false; }
  saving = true;
  syncBackupAvailability();
  try {
    const next = validateLibrary(typeof entries === 'function' ? entries() : entries);
    const nextSettings = typeof settings === 'function' ? settings() : settings || library.settings;
    savingCommand=commandRef;
    const outcome=await saveCoordinator.save(fixedPayload||{requestId:crypto.randomUUID(),revision:library.revision,entries:next,settings:preferences(nextSettings)});
    if(outcome.state!=='completed')throw outcome.error||Error('保存未完成，修改仍保留');
    library=outcome.result.library;
    if(library.revision>outcome.result.revision)toast('保存已完成；其他窗口随后又更新了档案。');
    timelineField = 'premiere';
    if (shouldRender) render(); else { applyPreferences(); renderNav(); }
    if (message) toast(message); return true;
  } catch (e) {
    // Only a definite rejection can release the queue. Read the latest archive
    // for a subsequent, newly identified edit; never rebase an uncertain one.
    if(e.status===409){try{library=await api('/api/library');applyPreferences();renderNav();}catch{/* Keep the current inputs and original conflict message. */}}
    if(throwOnError)throw e;toast(`未保存：${e.message}`);return false;
  }
  finally {
    savingCommand=null;saving = false; syncBackupAvailability();
    document.querySelectorAll('[data-resume-edit]').forEach(button=>button.disabled=saveCoordinator.unconfirmed);
    if(activeDialog==='dataDialog' && settingsTab==='data' && !dataOperation)void loadLocalBackups();
  }
}
function colour(item) {
  const palette = item.palette?.[0] && item.palette?.[1] ? item.palette : null;
  if (palette && !(palette[0] === '#6f8580' && palette[1] === '#263e42')) return `linear-gradient(145deg, ${palette[0]}, ${palette[1]})`;
  let hash = 0;
  for (const char of String(item.title || '')) hash = (hash * 33 + char.codePointAt(0)) % 360;
  const second = (hash + 42) % 360;
  return `linear-gradient(145deg, hsl(${hash} 42% 43%), hsl(${second} 48% 17%))`;
}
function picture(item, className = '') {
  const custom = customImageUrl(item.customCover), source = imageUrl(item.cover), cover = custom || source;
  const path = cover ? `/api/image?url=${encodeURIComponent(cover)}${custom ? '&custom=1' : ''}` : '';
  const sourcePath = custom && source ? `/api/image?url=${encodeURIComponent(source)}` : '';
  // The local proxy remains the first choice so covers can be cached and
  // exported. Some public CDNs resolve to a synthetic/private address on a
  // user's DNS, which the server must reject for SSRF safety; retain the
  // validated HTTPS URL as a browser-only fallback for that case.
  const direct = custom ? ` data-direct-cover="${esc(custom)}" referrerpolicy="no-referrer"` : '';
  return `<div class="art-fallback ${className} ${cover ? 'has-cover' : 'no-cover'}" data-mark="${esc(item.title.slice(0,2))}" style="--poster:${colour(item)}"><span aria-hidden="true">${esc(item.title.slice(0,12))}</span>${cover ? `<img src="${esc(path)}" alt="${esc(item.title)}封面" loading="lazy" data-cover="${esc(path)}"${sourcePath ? ` data-source-cover="${esc(sourcePath)}"` : ''}${direct} />` : ''}</div>`;
}
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset.sourceIcon) {
    img.hidden = true;
    img.parentElement?.classList.add('no-icon');
    return;
  }
  if (!img.dataset.cover) return;
  // Keep the server-side image proxy as the normal path, but let a validated
  // custom HTTPS cover try once in the browser when local DNS prevents the
  // proxy from reaching that public CDN. Images cannot execute scripts and
  // referrer data is suppressed, so this fallback does not create a proxy.
  if (img.dataset.directCover && !img.dataset.directTried) {
    img.dataset.directTried = '1';
    img.hidden = false;
    img.parentElement?.classList.remove('cover-error');
    img.src = img.dataset.directCover;
    return;
  }
  // Imported archives may contain a custom cover from a host that is no
  // longer reachable through the local safety proxy. If the same record has
  // a validated provider image, use it before showing a dead-cover state.
  if (img.dataset.sourceCover && !img.dataset.sourceTried) {
    img.dataset.sourceTried = '1';
    img.hidden = false;
    img.parentElement?.classList.remove('cover-error');
    img.src = img.dataset.sourceCover;
    return;
  }
  img.parentElement?.classList.add('cover-error');
  img.hidden = true;
  if (!img.dataset.retried) {
    img.dataset.retried = '1';
    const timer = setTimeout(() => { pendingImages.delete(timer); if (img.isConnected) { img.parentElement?.classList.remove('cover-error'); img.hidden = false; img.src = `${img.dataset.cover}&retry=1`; } }, 1200);
    pendingImages.add(timer);
  } else if (!img.parentElement.querySelector('.image-retry')) {
    const button = document.createElement('button'); button.className = 'image-retry'; button.textContent = '重试封面';
    button.onclick = e => {
      e.stopPropagation(); button.remove(); img.parentElement?.classList.remove('cover-error');
      // A custom URL gets a fresh chance through both paths. Without
      // resetting these flags, a failed direct attempt would make the button
      // retry only the proxy forever.
      if (img.dataset.directCover) { delete img.dataset.directTried; delete img.dataset.retried; img.hidden = false; img.src = img.dataset.cover; }
      else { img.hidden = false; img.src = `${img.dataset.cover}&retry=${Date.now()}`; }
    };
    img.parentElement.append(button);
  }
}, true);

function collectionFocusAnchor(node=document.activeElement){
  const grid=$('posterGrid');
  if(!grid.contains(node)||grid.closest('[inert]'))return null;
  const attribute=['data-open','data-progress-add','data-select'].find(name=>node.hasAttribute(name));
  if(!attribute)return null;
  return {attribute,id:node.getAttribute(attribute),index:[...grid.children].indexOf(node.closest('.poster-card')),view};
}
function restoreCollectionFocus(anchor){
  const grid=$('posterGrid');
  if(!anchor||workspace!=='collection'||anchor.view!==view||grid.hidden||grid.closest('[inert]'))return;
  const target=grid.querySelector(`[${anchor.attribute}="${CSS.escape(anchor.id)}"]`)
    ||grid.querySelector(`[data-open="${CSS.escape(anchor.id)}"]`)
    ||grid.children[Math.min(anchor.index,grid.children.length-1)]?.querySelector('.poster-open')
    ||(!$('addWork').hidden?$('addWork'):null);
  if(target&&!target.disabled){
    // Quick progress lives in the card's focus disclosure. Reveal its host
    // first; a hidden button cannot receive focus after its old node is gone.
    if(target.hasAttribute('data-progress-add'))target.closest('.poster-card')?.querySelector('.poster-open')?.focus({preventScroll:true});
    target.focus({preventScroll:true});
  }
}
function render() {
  // A resize or background save can replace the cards while someone is
  // using the keyboard. Keep the same work/control focused, without moving
  // the reading position or stealing focus from a dialog or toolbar.
  const focusAnchor=collectionFocusAnchor();
  applyPreferences(); renderNav();
  // Hidden grids report zero width; defer layout until the collection is visible.
  if (workspace !== 'collection') return;
  const prefs = uiPreferences(), activeList = prefs.lists.find(x => x.id === view) || prefs.lists.find(x => x.kind === 'all') || prefs.lists[0] || { id:'library', label:'收藏', kind:'all' };
  $('sectionTitle').textContent = activeList.label;
  $('sectionTitle').title = activeList.label;
  const normalizedTag = normalizeText(tag);
  const series = uiPreferences().series;
  const seriesById = new Map(series.map(value => [value.id, value]));
  const normalizedSeries = normalizeText(seriesFilterText);
  const matchesSeries = item => seriesFilter ? item.seriesId === seriesFilter : !normalizedSeries || normalizeText(seriesById.get(item.seriesId)?.label || '').includes(normalizedSeries);
  let items = listEntries(activeList).filter(x => (filterType === 'all' || x.type === filterType) && (!normalizedTag || x.tags.some(value => normalizeText(value).includes(normalizedTag))) && (!archiveYear || x.year === archiveYear) && (!archiveSeason || x.season === archiveSeason) && matchesSeries(x));
  items = sortEntries(items,prefs.sort); $('sortSelect').value = prefs.sort;
  const rootOverview = activeList.kind === 'all';
  const archiveEmpty = library.entries.length === 0;
  const filtered = filterType!=='all'||tag||archiveYear||archiveSeason||seriesFilter||seriesFilterText;
  const showEmpty = items.length === 0 && (!rootOverview || archiveEmpty);
  $('addWork').hidden = rootOverview && archiveEmpty;
  $('collectionOverview').hidden = !rootOverview || archiveEmpty;
  $('posterGrid').hidden = rootOverview;
  $('pagination').hidden = rootOverview;
  $('emptyState').hidden = !showEmpty;
  $('batchToolbar').hidden = rootOverview || !selectionMode;
  $('toggleSelection').hidden = rootOverview;
  $('filters').hidden = rootOverview;
  $('sortMenu').hidden = rootOverview;
  document.querySelector('.layout-toggle')?.toggleAttribute('hidden', rootOverview);
  if (rootOverview) {
    $('visibleCount').textContent = '';
    $('loadMoreEntries').hidden = true;
    if (archiveEmpty) renderCollectionEmpty({firstRun:true,label:activeList.label});
    else renderCollectionOverview(items);
    writeWorkspaceState();
    return;
  }
  ['filterType','filterSeason','sortSelect'].forEach(syncChoiceGroup);
  const sortLabel = $('sortLabel');
  if (sortLabel) sortLabel.textContent = $('sortSelect').selectedOptions[0]?.textContent || '排序';
  effectiveLayout = pageLayout(items.length, prefs.view === 'list' ? {...prefs,columns:1} : prefs, $('posterGrid').clientWidth, page, focusAnchor?items.findIndex(item=>item.id===focusAnchor.id):-1);
  page = effectiveLayout.page;
  const nextContinuousKey = [activeList.id, filterType, tag, archiveYear || '', archiveSeason, seriesFilter, seriesFilterText, prefs.sort, prefs.view, prefs.columns, prefs.rows].join('|');
  if (nextContinuousKey !== continuousKey) { continuousKey = nextContinuousKey; continuousShown = 120; }
  const isContinuous = prefs.rows === 0 && items.length > 120;
  const renderItems = isContinuous ? items.slice(0, continuousShown) : items.slice(effectiveLayout.start, effectiveLayout.start + effectiveLayout.pageSize);
  $('posterGrid').classList.toggle('list-mode', prefs.view === 'list');
  document.querySelectorAll('[data-layout-mode]').forEach(b => { b.classList.toggle('active', b.dataset.layoutMode === prefs.view); b.setAttribute('aria-pressed', String(b.dataset.layoutMode === prefs.view)); });
  $('posterGrid').style.gridTemplateColumns = prefs.view === 'list' ? '1fr' : `repeat(${effectiveLayout.columns}, minmax(0, 1fr))`;
  $('pagination').hidden = effectiveLayout.pages <= 1;
  $('pageInfo').textContent = `${page} / ${effectiveLayout.pages}`;
  $('previousPage').disabled = page === 1;
  $('nextPage').disabled = page === effectiveLayout.pages;
  $('posterGrid').innerHTML = renderItems.map(x => {
    const canAdvance = !selectionMode && x.status === 'watching' && x.total && x.progress < x.total;
    return `<article class="poster-card ${selectionMode && selectedIds.has(x.id) ? 'selected' : ''}" data-id="${esc(x.id)}">
    <button class="poster-open" data-open="${esc(x.id)}" aria-label="打开 ${esc(x.title)}">
    <div class="poster-visual">${picture(x)}${x.tags?.length ? `<div class="tag-chips" aria-label="标签">${x.tags.slice(0,2).map(label => `<span class="tag-chip">${esc(label)}</span>`).join('')}</div>` : ''}${(x.score || x.year || x.airedAt) ? `<div class="cover-meta" aria-label="作品摘要">${x.score ? `<span>★ ${x.score.toFixed(1)}</span>` : ''}${x.year || x.airedAt ? `<span>${x.year || new Date(x.airedAt).getUTCFullYear()}</span>` : ''}</div>` : ''}</div>
    <div class="poster-info"><h3>${esc(x.title)}</h3><p>${metaText(x, prefs)}</p></div></button>
    ${canAdvance ? `<div class="card-actions"><button type="button" data-progress-add="${esc(x.id)}" aria-label="${esc(x.title)} 已看一${unitText(x)}" title="已看 ${x.progress} / ${x.total} ${unitText(x)}">+1</button></div>` : ''}
    ${selectionMode ? `<label class="select-card"><input type="checkbox" data-select="${esc(x.id)}" ${selectedIds.has(x.id) ? 'checked' : ''} aria-label="选择 ${esc(x.title)}" /></label>` : ''}
    </article>`;
  }).join('');
  const more = $('loadMoreEntries');
  if (more) { more.hidden = !isContinuous || renderItems.length >= items.length; more.textContent = `继续加载 · ${renderItems.length} / ${items.length}`; }
  $('emptyState').hidden = items.length > 0;
  $('visibleCount').textContent=prefs.display.count ? `${items.length} 部` : '';
  if (!items.length) renderCollectionEmpty({filtered,firstRun:archiveEmpty,label:activeList.label});
  $('filters').querySelector('summary').textContent=filtered?'筛选 · 已启用':'筛选';
  const tags = allTags();
  $('filterTag').value = tag;
  $('filterTagOptions').innerHTML = tags.map(t=>`<option value="${esc(t)}"></option>`).join('');
  const years=[...new Set(library.entries.map(x=>x.year).filter(Boolean))].sort((a,b)=>b-a);
  $('filterYear').innerHTML='<option value="">全部年份</option>'+years.map(y=>`<option>${y}</option>`).join(''); $('filterYear').value=archiveYear || '';
  $('filterSeries').value = seriesFilter ? (seriesById.get(seriesFilter)?.label || '') : seriesFilterText;
  $('filterSeriesOptions').innerHTML = series.map(s=>`<option value="${esc(s.label)}"></option>`).join('');
  $('filterType').value=filterType; $('filterSeason').value=archiveSeason;
  ['filterType','filterSeason','sortSelect'].forEach(syncChoiceGroup);
  renderBatchToolbar();
  writeWorkspaceState();
  restoreCollectionFocus(focusAnchor);
}

function renderCollectionEmpty({ filtered = false, firstRun = false, label = '收藏' } = {}) {
  const state = $('emptyState');
  if (!state) return;
  state.classList.toggle('is-filtered', filtered);
  state.classList.toggle('is-first-run', firstRun);
  $('emptyKicker').textContent = filtered ? '筛选结果' : firstRun ? '收藏起点' : label;
  $('emptyTitle').textContent = filtered ? '没有符合条件的作品' : firstRun ? '从想看的第一部开始' : `“${label}”还是空的`;
  $('emptyDescription').textContent = filtered ? '调整条件，或清除筛选查看这个列表中的全部作品。' : firstRun ? '搜索可自动带回封面和资料，也可以手动记录或导入已有备份。' : '搜索或手动添加作品，再从详情中安排到这个列表。';
  $('emptyStartActions').hidden = filtered;
  $('emptyClearFilters').hidden = !filtered;
}
function activateSettingsTab(tab = settingsTab) {
  if(dataOperation || pendingDataResult())return;
  settingsTab = tab;
  document.querySelectorAll('[data-settings-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.settingsTab === tab)));
  document.querySelectorAll('[data-settings-panel]').forEach(p => p.hidden = p.dataset.settingsPanel !== tab);
  if (tab === 'general') loadGeneralSettings();
  if (tab === 'list') renderListManager();
  if (tab === 'tags') renderTagManager();
  if (tab === 'series') renderSeriesManager();
  if (tab === 'data') { syncChoiceGroup('importMode'); if(importBundle)importPreview(); loadLocalBackups(); }
  if (tab === 'about') loadAbout();
}
function managerNameKey(kind,id) { return `${kind}:${id}`; }
function managerNameLabel(kind,id) {
  return uiPreferences()[kind === 'list' ? 'lists' : 'series'].find(item=>item.id===id)?.label || '';
}
function managerNameField(kind,item) {
  const key=managerNameKey(kind,item.id), state=managerNames.get(key), value=state?.draft ?? item.label;
  const feedbackId=`manager-feedback-${encodeURIComponent(key)}`;
  const status=state?.status || 'saved', message=state?.error || ({pending:'待保存',saving:'保存中…'})[status] || '';
  return `<div class="manager-name-field" data-manager-name="${esc(key)}"><input data-${kind}-label="${esc(item.id)}" value="${esc(value)}" maxlength="${kind==='list'?30:40}" aria-label="${kind==='list'?'列表':'系列'}名称：${esc(item.label)}" aria-invalid="${status==='error'}" ${status==='error'?`aria-describedby="${esc(feedbackId)}"`:''} /><div class="manager-name-feedback" ${status==='saved'?'hidden':''}><span id="${esc(feedbackId)}" role="status">${esc(message)}</span><button type="button" class="text-btn" data-retry-manager-name="${esc(key)}" ${status==='error'?'':'hidden'}>重试</button></div></div>`;
}
function renderManagerContents(root,html) {
  const focused=document.activeElement, ownsFocus=root.contains(focused);
  const kind=focused?.dataset.listLabel?'list':focused?.dataset.seriesLabel?'series':'';
  const id=kind && focused.dataset[`${kind}Label`];
  const record=kind&&managerNames.get(managerNameKey(kind,id));
  if(ownsFocus&&record?.composing){record.redraw=true;return;}
  const selection=kind?{start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection}:null;
  const scroll=root.scrollTop;
  root.innerHTML=html;root.scrollTop=scroll;
  if(ownsFocus&&kind){const field=root.querySelector(`[data-${kind}-label="${CSS.escape(id)}"]`);field?.focus({preventScroll:true});field?.setSelectionRange(selection.start,selection.end,selection.direction);}
}
function updateManagerNameState(record,status,error) {
  if(status==='saved'&&record.composing&&record.draft!==null)status='pending';
  record.status=status;record.error=error?.message || '';
  const field=document.querySelector(`[data-manager-name="${CSS.escape(record.key)}"]`);
  if(!field)return;
  const input=field.querySelector('input'), feedback=field.querySelector('.manager-name-feedback');
  input.setAttribute('aria-invalid',String(status==='error'));
  if(status==='error')input.setAttribute('aria-describedby',feedback.querySelector('span').id);
  else input.removeAttribute('aria-describedby');
  feedback.hidden=status==='saved';
  feedback.querySelector('span').textContent=record.error || saveStatusLabel(status) || '';
  feedback.querySelector('button').hidden=status!=='error';
  if(status==='saved'&&record.draft===null){
    input.value=managerNameLabel(record.kind,record.id);
    input.setAttribute('aria-label',`${record.kind==='list'?'列表':'系列'}名称：${input.value}`);
  }
}
function managerNameSaver(kind,id) {
  const key=managerNameKey(kind,id);
  if(managerNames.has(key))return managerNames.get(key);
  const record={key,kind,id,draft:null,status:'saved',error:'',composing:false};
  record.save=createAutosave({delay:450,write:async ({value,recoveryVersion})=>{
    if(record.removed)return;
    const label=String(value).normalize('NFKC').trim().replace(/\s+/g,' ').slice(0,kind==='list'?30:40);
    if(!label)throw Error('名称不能为空');
    const field=kind==='list'?'lists':'series';
    if(uiPreferences()[field].some(item=>item.id!==id&&normalizeText(item.label)===normalizeText(label)))throw Error('名称已存在');
    const ok=await commit(()=>library.entries,'',()=>{
      const latest=uiPreferences(), items=latest[field];
      if(record.removed)return latest;
      if(!items.some(item=>item.id===id))throw Error('项目已不存在，未写入修改');
      if(items.some(item=>item.id!==id&&normalizeText(item.label)===normalizeText(label)))throw Error('名称已存在');
      return {...latest,[field]:items.map(item=>item.id===id?{...item,label}:item)};
    },{render:false,throwOnError:true}).catch(error=>{throw Error(`未保存：${error.message}`);});
    if(!ok)throw Error('保存失败，修改仍保留');
    await forgetEdit('manager',key,recoveryVersion);
    if(record.draft===value)record.draft=null;
    if(workspace==='collection')render();
  },state:(status,error)=>updateManagerNameState(record,status,error)});
  managerNames.set(key,record);return record;
}
function queueManagerName(input) {
  const kind=input.dataset.listLabel?'list':'series', id=input.dataset[`${kind}Label`];
  const record=managerNameSaver(kind,id);record.draft=input.value;
  const recoveryVersion=rememberEdit('manager',record.key,{value:input.value,kind,id},`${kind==='list'?'列表':'系列'}：${input.value}`);
  if(record.composing)updateManagerNameState(record,'pending');
  else record.save.schedule({value:input.value,recoveryVersion});
}
async function flushManagerNames(onFailure = () => {}) {
  for(const record of managerNames.values()){
    // An IME may still own the input when Escape reaches the dialog. Do not
    // rebuild its panel or move focus until the composition has finished.
    if(record.composing){onFailure();return false;}
    if(!await record.save.flush()){
      onFailure();
      if(record.kind==='series'){seriesSearch='';$('seriesSearch').value='';}
      activateSettingsTab(record.kind==='list'?'list':'series');
      document.querySelector(`[data-${record.kind}-label="${CSS.escape(record.id)}"]`)?.focus();
      return false;
    }
  }
  return true;
}
function managerNamesDirty() { return [...managerNames.values()].some(record=>record.composing||record.draft!==null||record.save.dirty); }
function renderListManager() {
  const lists = uiPreferences().lists;
  const atLimit = lists.length >= MAX_LISTS;
  if ($('listSummary')) $('listSummary').textContent = `${lists.length} / ${MAX_LISTS}`;
  if ($('newListName')) $('newListName').disabled = atLimit;
  if ($('addList')) $('addList').disabled = atLimit;
  const html = lists.length ? lists.map((list, i) => {
    const icon = LIST_ICONS[list.status || list.id] || '□';
    const movable = list.kind !== 'all';
    const count = listEntries(list).length;
    const remove = movable ? (pendingListDelete === list.id
      ? `<span class="manager-delete-question">确定删除？</span><button class="text-btn danger" data-confirm-delete-list="${esc(list.id)}">删除</button><button class="text-btn" data-cancel-delete-list="${esc(list.id)}">取消</button>${managerDeleteMessage('list',list.id)}`
      : `<button class="text-btn danger list-delete-trigger" data-delete-list="${esc(list.id)}" aria-label="删除 ${esc(list.label)}" title="删除列表">×</button>`) : '';
    return `<div class="manager-row list-row" data-list-row="${esc(list.id)}" data-list-kind="${esc(list.kind)}"><span class="manager-index">${String(i + 1).padStart(2,'0')}</span><span class="manager-icon" aria-hidden="true">${icon}</span><button type="button" class="list-drag-handle" draggable="${movable}" data-list-drag="${esc(list.id)}" aria-label="调整 ${esc(list.label)} 的顺序；可拖动或使用上下方向键" title="拖动排序">⠿</button>${managerNameField('list',list)}<span class="manager-kind" title="${count} 部作品">${count} 部</span>${movable ? `<span class="manager-delete-actions" role="group" aria-label="${esc(list.label)}删除操作">${remove}</span>` : ''}</div>`;
  }).join('') : '<p class="data-footnote">暂无自定义列表</p>';
  renderManagerContents($('listManager'),html);
}
function clearListDragState() {
  document.querySelectorAll('.list-row.is-dragging,.list-row.drop-before,.list-row.drop-after').forEach(row => row.classList.remove('is-dragging','drop-before','drop-after'));
}
async function moveList(sourceId, targetRow, before) {
  clearListDragState();
  if (!sourceId || !targetRow || targetRow.dataset.listKind === 'all' || targetRow.dataset.listRow === sourceId) return false;
  const targetId=targetRow.dataset.listRow;
  if (await commitCommand({type:'move-list',id:sourceId,targetId,before},'',{render:false})) { renderNav(); if (workspace === 'collection') render(); renderListManager(); return true; }
  return false;
}
function allTags() {
  return [...new Set([...uiPreferences().tags, ...library.entries.flatMap(x => x.tags || [])])].sort((a,b) => a.localeCompare(b,'zh'));
}
function cleanEntryTag(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 40);
}
function cleanSeriesLabel(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 40);
}
function parseTags(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (Array.isArray(parsed)) return [...new Set(parsed.map(cleanEntryTag).filter(Boolean))].slice(0, MAX_ENTRY_TAGS);
  } catch { /* Legacy drafts may have used comma-separated values. */ }
  return String(value || '').split(/[,，]/).map(cleanEntryTag).filter(Boolean).slice(0, MAX_ENTRY_TAGS);
}
function entryTagValues() {
  return parseTags($('entryTagsValue')?.value || '[]');
}
function renderEntryTagSuggestions() {
  const root = $('entryTagSuggestions'), input = $('entryTagInput');
  if (!root || !input) return;
  if (input.disabled) { root.innerHTML=''; root.hidden=true; return; }
  const query = cleanEntryTag(input.value), selected = new Set(entryTagValues()), normalized = normalizeText(query);
  const matches = allTags().filter(tag => !selected.has(tag) && (!normalized || normalizeText(tag).includes(normalized))).slice(0, 8);
  const create = query && !selected.has(query) && !allTags().some(tag => tag === query);
  root.innerHTML = [...matches.map(tag => `<button type="button" class="tag-suggestion" data-entry-tag-add="${esc(tag)}">${esc(tag)}</button>`), create ? `<button type="button" class="tag-suggestion tag-suggestion-new" data-entry-tag-add="${esc(query)}">添加“${esc(query)}”</button>` : ''].join('');
  root.hidden = !root.children.length;
}
function renderEntryTagPicker(tags = []) {
  const values = [...new Set(tags.map(cleanEntryTag).filter(Boolean))].slice(0, MAX_ENTRY_TAGS);
  const hidden = $('entryTagsValue'), chips = $('entryTagChips');
  if (!hidden || !chips) return;
  hidden.value = JSON.stringify(values);
  chips.innerHTML = values.map(tag => `<button type="button" class="entry-tag-chip" data-entry-tag-remove="${esc(tag)}" aria-label="移除标签 ${esc(tag)}"><span>${esc(tag)}</span><b aria-hidden="true">×</b></button>`).join('');
  if ($('entryTagInput')) {
    $('entryTagInput').disabled = values.length >= MAX_ENTRY_TAGS;
    $('entryTagInput').placeholder = values.length >= MAX_ENTRY_TAGS ? `已达 ${MAX_ENTRY_TAGS} 个标签上限` : '输入后按 Enter 添加';
  }
  renderEntryTagSuggestions();
}
function addEntryTag(value) {
  const tag = cleanEntryTag(value); if (!tag) return;
  const values = entryTagValues(); if (values.includes(tag)) return;
  if (values.length >= MAX_ENTRY_TAGS) return toast(`每部作品最多添加 ${MAX_ENTRY_TAGS} 个标签。`);
  renderEntryTagPicker([...values, tag]);
  if ($('entryTagInput')) $('entryTagInput').value = '';
  queueEntryEdit();
}
function tagHue(value) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 33 + char.codePointAt(0)) % 360;
  return 175 + (hash % 165);
}
function renderTagManager() {
  const prefs = uiPreferences(), all = allTags(), query = normalizeText(tagSearch);
  const tags = query ? all.filter(t => normalizeText(t).includes(query)) : all;
  const usage = new Map(all.map(t => [t, 0]));
  for (const item of library.entries) for (const value of item.tags || []) if (usage.has(value)) usage.set(value,(usage.get(value) || 0) + 1);
  const used = all.filter(t => usage.get(t)).length;
  const atLimit = prefs.tags.length >= MAX_MANAGED_TAGS;
  if ($('newTagName')) $('newTagName').disabled = atLimit;
  if ($('addTag')) $('addTag').disabled = atLimit;
  const summary = query ? `显示 ${tags.length} / ${all.length} 个标签` : `${all.length} 个标签 · ${used} 个已用于作品${atLimit ? ' · 已达管理上限' : ''}`;
  $('tagSummary').textContent = all.length ? summary : '';
  const manager = $('tagManager');
  manager.classList.toggle('has-long-labels',tags.some(t => [...t].length > 14));
  manager.innerHTML = tags.length ? tags.map(t => {
    const count = usage.get(t) || 0, hue = tagHue(t);
    const remove = pendingTagDelete === t
      ? `<span class="manager-delete-question">确认？</span><button class="text-btn danger" data-confirm-delete-tag="${esc(t)}" aria-label="确认删除标签 ${esc(t)}">删除</button><button class="text-btn" data-cancel-delete-tag="${esc(t)}">取消</button>${managerDeleteMessage('tag',t)}`
      : `<button class="tag-remove" type="button" data-delete-tag="${esc(t)}" aria-label="删除标签 ${esc(t)}">×</button>`;
    return `<article class="tag-manager-card" style="--tag-hue:${hue}" data-tag-card="${esc(t)}"><div class="tag-card-head"><span class="tag-pill"><i aria-hidden="true"></i><span title="${esc(t)}">${esc(t)}</span></span><span class="tag-card-actions" role="group" aria-label="${esc(t)}删除操作">${remove}</span></div><div class="tag-card-meta"><span>${count ? `已用于 ${count} 部作品` : '暂未使用'}</span></div></article>`;
  }).join('') : `<div class="tag-empty">${all.length ? '没有匹配标签' : '还没有标签'}</div>`;
}
function renderSeriesManager() {
  const prefs = uiPreferences(), all = prefs.series, query = normalizeText(seriesSearch);
  const series = query ? all.filter(s => normalizeText(s.label).includes(query)) : all;
  const members = new Map(all.map(item => [item.id, []]));
  for (const item of library.entries) if (members.has(item.seriesId)) members.get(item.seriesId).push(item);
  const assigned = [...members.values()].reduce((sum, items) => sum + items.length, 0);
  const atLimit = all.length >= MAX_SERIES;
  if ($('newSeriesName')) $('newSeriesName').disabled = atLimit;
  if ($('addSeries')) $('addSeries').disabled = atLimit;
  $('seriesSummary').textContent = all.length ? (query ? `显示 ${series.length} / ${all.length} 个系列` : `${all.length} 个系列 · ${assigned} 部作品已归组${atLimit ? ' · 已达管理上限' : ''}`) : '';
  const html = series.length ? series.map(s => {
    const items = members.get(s.id) || [], count = items.length;
    const preview = items.slice(0, 3).map(item => {
      const initial = [...(item.title || '·')][0] || '·';
      return `<span title="${esc(item.title)}" aria-hidden="true">${esc(initial)}</span>`;
    }).join('');
    const stack = `<span class="series-member-stack${count ? '' : ' is-empty'}" aria-label="${count ? `${esc(s.label)}包含${count}部作品` : `${esc(s.label)}暂未添加作品`}">${preview || '<span aria-hidden="true">—</span>'}${count > 3 ? `<b aria-hidden="true">+${count - 3}</b>` : ''}</span>`;
    const remove = pendingSeriesDelete === s.id
      ? `<span class="manager-delete-question">删除此系列？</span><button class="text-btn danger" data-confirm-delete-series="${esc(s.id)}">删除</button><button class="text-btn" data-cancel-delete-series="${esc(s.id)}">取消</button>${managerDeleteMessage('series',s.id)}`
      : `<button class="series-delete-trigger" type="button" data-delete-series="${esc(s.id)}" aria-label="删除系列 ${esc(s.label)}">×</button>`;
    return `<article class="series-card" data-series-row="${esc(s.id)}"><div class="series-card-head">${stack}<span class="series-delete-actions" role="group" aria-label="${esc(s.label)}删除操作">${remove}</span></div>${managerNameField('series',s)}<div class="series-card-meta"><span>${count ? `${count} 部作品` : '暂未添加作品'}</span>${count ? `<button class="text-btn series-view" data-series-view="${esc(s.id)}">查看作品</button>` : ''}</div></article>`;
  }).join('') : `<div class="tag-empty">${all.length ? '没有匹配系列' : '还没有系列'}</div>`;
  renderManagerContents($('seriesManager'),html);
}
function entrySeriesOptions() {
  const query = normalizeText($('entrySeriesQuery')?.value || '');
  const all = uiPreferences().series;
  return (query ? all.filter(item => normalizeText(item.label).includes(query)) : all).slice(0, 8);
}
function closeEntrySeriesSuggestions() {
  const input = $('entrySeriesQuery'), panel = $('entrySeriesSuggestions');
  if (!input || !panel) return;
  panel.hidden = true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant');
}
function renderEntrySeriesSuggestions() {
  const input = $('entrySeriesQuery'), panel = $('entrySeriesSuggestions');
  if (!input || !panel) return;
  const options = entrySeriesOptions();
  seriesPickerIndex = Math.max(0, Math.min(seriesPickerIndex, Math.max(0, options.length - 1)));
  panel.innerHTML = options.map((item,index) => `<button type="button" id="entry-series-option-${index}" role="option" data-entry-series-option="${esc(item.id)}" aria-selected="${index === seriesPickerIndex}">${esc(item.label)}</button>`).join('');
  const open = options.length > 0;
  panel.hidden = !open; input.setAttribute('aria-expanded',String(open));
  if (open) input.setAttribute('aria-activedescendant',`entry-series-option-${seriesPickerIndex}`); else input.removeAttribute('aria-activedescendant');
}
function setEntrySeries(id, save = false) {
  const item = uiPreferences().series.find(series => series.id === id);
  const hidden = $('entrySeries'), input = $('entrySeriesQuery'), clear = $('clearEntrySeries');
  if (!hidden || !input || !clear) return;
  const next = item?.id || '', changed = hidden.value !== next;
  hidden.value = next; input.value = item?.label || ''; clear.hidden = !next;
  closeEntrySeriesSuggestions();
  if (save && changed) queueEntryEdit();
}
function syncChoiceGroup(selectId) {
  const select = $(selectId); if (!select) return;
  document.querySelectorAll(`[data-choice-for="${selectId}"] [data-choice]`).forEach(button => {
    const active = button.dataset.choice === select.value;
    button.setAttribute('aria-checked', String(active));
    button.setAttribute('aria-pressed', String(active));
  });
}
function syncModeToggle() {
  const select = $('modeSelect'), button = $('modeToggle');
  if (!select || !button) return;
  const dark = select.value === 'dark';
  button.setAttribute('aria-pressed', String(dark));
  button.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到夜间模式');
  button.dataset.mode = dark ? 'dark' : 'light';
  if ($('modeToggleIcon')) $('modeToggleIcon').textContent = dark ? '☾' : '☀';
  if ($('modeToggleLabel')) $('modeToggleLabel').textContent = dark ? '夜间' : '白天';
}
function chooseSetting(button) {
  const selectId = button.closest('[data-choice-for]')?.dataset.choiceFor, select = $(selectId);
  const value = button.dataset.choice || '';
  if (!select || ![...select.options].some(option => option.value === value)) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncChoiceGroup(selectId);
  if (button.closest('#sortMenu')) button.closest('#sortMenu').open = false;
}
function loadGeneralSettings() {
  const prefs = uiPreferences();
  $('layoutColumns').value = prefs.columns; $('layoutRows').value = prefs.rows;
  $('showType').checked = prefs.display.type; $('showRating').checked = prefs.display.rating; $('showCount').checked = prefs.display.count;
  $('timeDisplay').value = prefs.display.year ? prefs.time : 'hidden'; $('themeSelect').value = prefs.theme; $('modeSelect').value = prefs.mode; $('accentColor').value = prefs.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#83aaff';
  ['layoutColumns','layoutRows','timeDisplay','themeSelect','modeSelect'].forEach(syncChoiceGroup);
  syncModeToggle();
  if ($('generalSaveState')) {
    $('generalSaveState').textContent = saveStatusLabel(settingsStatus);
    $('generalSaveState').hidden = settingsStatus === 'saved';
    $('generalSaveState').parentElement.hidden = settingsStatus === 'saved';
  }
  if ($('retrySettings')) $('retrySettings').hidden = settingsStatus !== 'error';
}
function loadSettings() { loadGeneralSettings(); renderListManager(); renderTagManager(); renderSeriesManager(); activateSettingsTab(settingsTab); }
function updateSavedEntry(id, update, message = '', options = {}) {
  // Resolve the record when this serial write starts, not when the control
  // was clicked. Independent edits must not replace a newer note or rating.
  const target=library.entries.find(item=>item.id===id),logical=`${id}:${crypto.randomUUID()}`;
  const version=options.recovery&&target?rememberEdit('fields',id,{patch:options.recovery,action:options.recoveryAction||'fields'},target.title,logical):null;
  return commit(() => {
    const latest = library.entries.find(item => item.id === id);
    if (!latest) throw Error('作品已不存在，未写入修改');
    const next = entry({...update(latest),updatedAt:new Date().toISOString()});
    return library.entries.map(item => item.id === id ? next : item);
  },message,undefined,options).then(async ok=>{if(ok&&version)await forgetEdit('fields',logical,version);return ok;});
}
async function setProgress(id, value) {
  const before=library.entries.find(item=>item.id===id),progress=Math.max(0,Math.min(before?.total||9999,Number(value)||0));
  const status=before?.total&&progress===before.total?'completed':['completed','planned'].includes(before?.status)?'watching':before?.status;
  const ok = await updateSavedEntry(id, latest => {
    const progress = Math.max(0, Math.min(latest.total || 9999, Number(value) || 0));
    const status = latest.total && progress === latest.total ? 'completed' : latest.status === 'completed' || latest.status === 'planned' ? 'watching' : latest.status;
    return {...latest,progress,status};
  },'',{recovery:{progress,status},recoveryAction:'progress'});
  if (current?.id === id) await openDetail(library.entries.find(item => item.id === id), false);
  return ok;
}
function modalState() {
  const opened = Boolean(activeDialog || current);
  document.body.classList.toggle('modal-open', opened);
  document.querySelector('.app-shell').inert = opened;
  $('detailDrawer').inert = !current || Boolean(activeDialog);
  syncNoticeLocation();
}
async function showDialog(id) {
  if (activeDialog && !await hideDialog(activeDialog)) return false;
  lastFocus = document.activeElement; activeDialog = id;
  $(id).hidden = false; modalState();
  requestAnimationFrame(() => $(id).querySelector('input, button, select')?.focus());
}
async function hideDialog(id) {
  if(id==='dataDialog' && (dataOperation || pendingDataResult()))return false;
  if(id==='dataDialog'&&!await flushManagerNames())return false;
  if(id==='entryDialog' && (formComposing || entryAdding || entryAddAttempt?.pending&&!entryAddAttempt.prepared))return false;
  if(id==='entryDialog' && entryAddAttempt?.pending){$(id).hidden=true;activeDialog=null;modalState();lastFocus?.focus?.();void loadEntryRecovery();return true;}
  if(id==='entryDialog' && entryDiscardOpen){cancelEntryDiscard();return false;}
  if(id==='entryDialog' && editId && (formDirty || entrySave.dirty)) {
    if(formComposing || !await entrySave.flush())return false;
  } else if (id==='entryDialog' && formDirty) {askEntryDiscard();return false;}
  if(id==='entryDialog'&&!editId&&formDraftRecord){await formDraftSave.cancel();if(!await discardFormDraft())return false;}
  $(id).hidden = true;
  if (id === 'dataDialog') applyPreferences();
  if (activeDialog===id) activeDialog=null;
  if(id==='entryDialog')formDirty=false; modalState(); lastFocus?.focus?.(); return true;
}
function detailListPicker(item, saved = false) {
  const lists = uiPreferences().lists.filter(list => list.kind !== 'all');
  if (!lists.length) return '';
  const selected = new Set(item.lists || []);
  // System lists are still rendered as ordinary list chips.  Keep the legacy
  // status field as an internal compatibility value, but derive its checked
  // chip from the selected list so the drawer never exposes a second status
  // control.
  // A remote result has no local status yet.  Give it the normal destination
  // (the planned list) so adding a new work never leaves it only in the root
  // collection. Users can still tick any number of other lists before saving.
  const defaultStatus = saved ? (item.status || 'planned') : 'planned';
  lists.filter(list => list.kind === 'status' && list.status === defaultStatus).forEach(list => selected.add(list.id));
  return `<fieldset class="detail-lists"><legend>列表</legend><div>${lists.map(list => `<label><input type="checkbox" data-detail-list="${esc(list.id)}" data-detail-kind="${esc(list.kind)}" data-detail-status="${esc(list.status || '')}" ${selected.has(list.id) ? 'checked' : ''} /><span>${esc(list.label)}</span></label>`).join('')}</div></fieldset>`;
}
function detailListSelection(item, ids, saved = false) {
  const prefs = uiPreferences();
  const byId = new Map(prefs.lists.map(list => [list.id, list]));
  const selected = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
  const statusList = selected.find(list => list.kind === 'status');
  const fallbackStatus = prefs.lists.find(list => list.kind === 'status' && list.status === (saved ? (item.status || 'planned') : 'planned'));
  const customIds = selected.filter(list => list.kind === 'custom').map(list => list.id);
  const status = statusList?.status || fallbackStatus?.status || item.status;
  return { ...item, lists: customIds, status, progress:status === 'completed' && item.total ? item.total : item.progress };
}
function detailSourceLabel(item) {
  const key = item.source || item.sourceId?.split(':')[0] || 'manual';
  return NAMES[key] || key || '来源';
}
async function openDetail(item, focus = true) {
  if(detailAdding)return;
  if (activeDialog && !await hideDialog(activeDialog))return;
  const saved = library.entries.find(x => x.id===item.id || (item.sourceId && x.sourceId === item.sourceId));
  if (saved) item = saved;
  const sameItem = current?.id === item.id;
  if(!sameItem)detailAddAttempt=null;
  // Replacing a textarea during IME composition cancels the candidate
  // session. Other fields may save, but redraw only once composition ends.
  if (sameItem && noteComposing) { detailRedrawPending=true; return; }
  if (!sameItem && noteComposing) return;
  if (!sameItem && dirty && !await noteSave.flush()) return;
  const noteInput = $('noteInput');
  const detailScroll = sameItem ? $('drawerContent').scrollTop : 0;
  const noteDraft = sameItem && dirty && noteInput ? noteInput.value : null;
  const noteSelection = sameItem && document.activeElement === noteInput ? {start:noteInput.selectionStart,end:noteInput.selectionEnd,direction:noteInput.selectionDirection,scroll:noteInput.scrollTop} : null;
  current = item;
  if (focus) lastFocus = document.activeElement;
  const focused = document.activeElement;
  const focusSelector = focused?.id ? `#${focused.id}` : focused?.dataset.detailList ? `[data-detail-list="${CSS.escape(focused.dataset.detailList)}"]` : focused?.dataset.rating ? `[data-rating="${focused.dataset.rating}"]` : focused?.dataset.status ? `[data-status="${focused.dataset.status}"]` : '';
  $('detailBackdrop').hidden = false; $('detailDrawer').classList.add('open'); $('detailDrawer').setAttribute('aria-hidden','false'); modalState();
  const sourceHref = item.sourceUrl || sourceUrl(item.sourceId);
  const userTags = item.tags || [], sourceGenres = item.genres || [];
  const description = item.description || '暂无作品背景';
  const sourceLabel = detailSourceLabel(item);
  $('drawerContent').innerHTML = `<div class="drawer-hero" style="--poster:${colour(item)}">${picture(item,'detail-cover')}<div class="drawer-hero-content"><div class="section-kicker">${esc(sourceLabel)}</div><h2>${esc(item.title)}</h2>${item.originalTitle ? `<p class="drawer-original">${esc(item.originalTitle)}</p>` : ''}<p class="drawer-description">${esc(description)}</p></div></div>
    <div class="drawer-body">${saved?'<div class="detail-actions manage-row"><button class="text-btn" id="editEntry">编辑作品</button><button class="text-btn" id="refreshMetadata" '+(!item.sourceId?'disabled':'')+'>刷新资料</button><button class="text-btn danger" id="removeEntry">移出收藏</button></div>':''}<div class="detail-stats"><div><small>首播</small><b>${item.year || '待补充'} ${esc(item.season)}</b></div><div><small>类型 · 集数</small><b>${TYPE[item.type]} · ${item.total || '?'} ${unitText(item)}</b></div><div><small>${esc(sourceLabel)}评分</small><b>${item.score ? item.score.toFixed(1) : '暂无'}</b></div></div>
    ${userTags.length ? `<section class="detail-tags"><h3>标签</h3><div class="tag-row">${userTags.map(t => `<span class="tag user-tag">${esc(t)}</span>`).join('')}</div></section>` : ''}${sourceGenres.length ? `<section class="detail-tags"><h3>题材</h3><div class="tag-row source-tags">${sourceGenres.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></section>` : ''}${detailListPicker(item, Boolean(saved))}
    ${saved ? `<div class="drawer-controls"><section><h3>进度</h3><div class="progress-editor"><div class="track"><i style="width:${item.total ? item.progress/item.total*100 : 0}%"></i>${item.total ? `<input id="progressRange" type="range" min="0" max="${item.total}" value="${item.progress}" step="1" aria-label="调整${unitText(item)}进度" />` : ''}</div></div><div class="progress-state"><div class="progress-label" id="progressLabel">${item.progress} / ${item.total || '?'} ${unitText(item)} ${!item.total ? `· 总${unitText(item)}数未知，可手动补充` : ''}</div>${item.status === 'completed' && item.progress > 0 ? '<button type="button" class="progress-restart" id="restartEntry" title="将进度重置为 0，并移至在看">从头重看</button>' : ''}</div></section><section><h3>评分</h3><div class="rating-row">${[1,2,3,4,5].map(n=>`<button data-rating="${n}" aria-label="评分 ${n} 星" aria-pressed="${item.rating===n}" class="${n<=item.rating?'on':''}">★</button>`).join('')}<button data-rating="0" class="clear-rating" aria-label="清除评分">清除</button></div></section></div>
    <section class="drawer-note-section"><div class="drawer-note-head"><h3>笔记</h3><span class="note-save-state" id="noteSaveState" role="status" aria-live="polite">已保存</span><button class="text-btn" id="retryNote" hidden>重试</button></div><textarea id="noteInput" class="drawer-note" maxlength="4000" aria-label="笔记">${esc(item.note)}</textarea></section>` : `<div class="detail-add-actions"><button class="primary-btn add-to-library" id="addEntry">添加到列表</button><button class="text-btn" id="editRemote">编辑资料</button></div><p id="detailAddState" class="entry-add-state" role="status" tabindex="-1" hidden></p>`}
    <div class="source-detail"><p>资料来源：${esc(sourceLabel)}${item.fetchedAt ? ` · 获取于 ${new Date(item.fetchedAt).toLocaleString('zh-CN')}` : ''}</p>${sourceHref ? `<a class="source-link" href="${esc(sourceHref)}" target="_blank" rel="noopener noreferrer">查看来源页面 ↗</a>` : ''}</div></div>`;
  dirty = noteDraft !== null;
  $('drawerContent').scrollTop = detailScroll;
  if (saved) {
    if (noteDraft !== null) $('noteInput').value = noteDraft;
    $('noteSaveState').textContent = noteStatusText();
    $('retryNote').hidden = noteStatus !== 'error';
  }
  if (focus) $('closeDrawer').focus();
  else if (focusSelector) $('detailDrawer').querySelector(focusSelector)?.focus({preventScroll:true});
  if (noteSelection && $('noteInput')) {
    $('noteInput').setSelectionRange(noteSelection.start,noteSelection.end,noteSelection.direction);
    $('noteInput').scrollTop = noteSelection.scroll;
  }
  syncDetailAddLock();
}
async function closeDetail() {
  if(detailAdding || detailAddAttempt?.pending&&!detailAddAttempt.prepared)return;
  if (noteComposing) return;
  if (dirty && !await noteSave.flush()) return;
  $('detailDrawer').classList.remove('open'); $('detailDrawer').setAttribute('aria-hidden','true'); $('detailBackdrop').hidden = true; current = null; dirty = false; detailRedrawPending=false; modalState(); lastFocus?.focus?.();
}
async function openForm(item, coverOnly = false, recovered = null) {
  if (current) { await closeDetail(); if (current) return false; }
  if(activeDialog && !await hideDialog(activeDialog))return false;
  manualEnrichQuery = '';
  coverVersion++; $('coverFeedback').textContent='';
  entryAddAttempt=null;entryDiscardOpen=false;resetEntryAddNotice();syncEntryAddLock();
  const savedItem = !recovered && item ? library.entries.find(x=>x.id===item.id || (item.sourceId && x.sourceId === item.sourceId)) : null;
  item = savedItem || item || null;
  entryObservedDraft=null;entryChangedFields=new Set();entryEditSaveStatus='saved';
  entrySeed = savedItem ? null : item;
  editId = savedItem?.id || null;
  formDraftRecord=editId?null:recovered || {id:crypto.randomUUID(),version:0};
  if(formDraftRecord)draftWriteVersions.set(formDraftRecord.id,formDraftRecord.version);
  $('forkEntryDraft').hidden=true;
  $('entryForm').reset(); $('entryTitle').textContent = editId ? '编辑作品' : '添加作品';
  $('entryForm').querySelector('details').open=false;
  for (const k of ['title','type','year','total','status','note','progress','originalTitle','season','region','description','customCover']) if ($('entryForm').elements[k]) $('entryForm').elements[k].value = item?.[k] ?? (k==='type'?'anime':k==='status'?'planned':k==='progress'?0:'');
  ['entryType','entryStatus','entrySeason','entryRegion'].forEach(syncChoiceGroup);
  renderEntryTagPicker(item?.tags || []);
  $('entryForm').elements.aliases.value = item?.aliases.join(', ') || '';
  const entryLists = uiPreferences().lists.filter(list => list.kind !== 'all');
  const selectedLists = new Set(item?.lists || []);
  const entryStatus = item?.status || 'planned';
  entryLists.filter(list => list.kind === 'status' && list.status === entryStatus).forEach(list => selectedLists.add(list.id));
  $('entryStatus').value = entryStatus;
  $('listMembership').closest('fieldset').hidden = !entryLists.length;
  $('listMembership').innerHTML = entryLists.map(list => `<label class="${list.kind === 'status' ? 'list-system-option' : 'list-custom-option'}"><input type="checkbox" name="lists" value="${esc(list.id)}" data-entry-list-kind="${esc(list.kind)}" data-entry-list-status="${esc(list.status || '')}" ${selectedLists.has(list.id) ? 'checked' : ''} /><span>${esc(list.label)}</span></label>`).join('');
  setEntrySeries(item?.seriesId || '');
  if(recovered){
    const draft=recovered.draft;
    for(const [key,value] of Object.entries(draft.values))if($('entryForm').elements[key]&&!['lists','tags','seriesId'].includes(key))$('entryForm').elements[key].value=value;
    ['entryType','entryStatus','entrySeason','entryRegion'].forEach(syncChoiceGroup);
    renderEntryTagPicker(parseTags(draft.values.tags));setEntrySeries(draft.values.seriesId || '');
    $('listMembership').querySelectorAll('input').forEach(input=>{input.checked=input.dataset.entryListKind==='status'?input.dataset.entryListStatus===draft.values.status:draft.lists.includes(input.value);});
    manualEnrichQuery=draft.enrichQuery;
  }
  formDirty=false;formVersion++;formComposing=false;
  entryBaseline=entryDraftSignature();
  if(recovered){entryBaseline=recovered.draft.baseline;formDirty=entryDraftSignature()!==entryBaseline;}
  lastQueuedDraftSignature=entryDraftSignature();
  if(editId)entryObservedDraft=captureEntryDraft();
  $('entrySaveState').hidden=!editId;$('entrySaveState').textContent='已保存';$('retryEntrySave').hidden=true;
  $('cancelEntry').hidden=Boolean(editId);$('createEntry').hidden=Boolean(editId);
  $('entryFooter').hidden=Boolean(editId);$('entryAddActions').hidden=false;$('entryDiscard').hidden=true;
  $('createEntry').textContent='添加作品';
  $('cancelEntry').textContent='取消';
  await showDialog('entryDialog');
  if(recovered){
    $('entrySaveState').hidden=false;$('entrySaveState').textContent='草稿已恢复';
    if(recovered.intent){entryAddAttempt={next:recovered.intent.entry,enrichQuery:recovered.draft.enrichQuery,payload:{...recovered.intent,draftId:recovered.id},pending:true,prepared:true,record:recovered,draft:recovered.draft};syncEntryAddLock();$('createEntry').textContent='继续添加';entryAddNotice('已恢复未确认的添加。继续将核对同一次操作，不会重复收录。');}
  }
  if (coverOnly) requestAnimationFrame(()=>$('customCoverInput').focus());
  return true;
}
async function openSearch() { if (current) { await closeDetail(); if(current) return; } if (activeDialog && !await hideDialog(activeDialog)) return; openWorkspace('search'); renderSearch(); $('searchInput').focus(); loadSearchSeason(); }
function manualSeed(query) {
  const raw = String(query || '').trim().slice(0, 100);
  const year = raw.match(/\b(?:18|19|20|21)\d{2}\b/)?.[0] || '';
  const seasonMatch = raw.match(/(?:^|\s)([冬春夏秋])(?:季|番)?(?=\s|$)/) || raw.match(/(?:18|19|20|21)\d{2}([冬春夏秋])(?:季|番)?(?=\s|$)/);
  const season = seasonMatch?.[1] || '';
  const title = raw.replace(/\b(?:18|19|20|21)\d{2}\b/g, '').replace(/(?:^|\s)[冬春夏秋](?:季|番)?(?=\s|$)/g, ' ').replace(/\s{2,}/g, ' ').trim() || raw;
  return { title, year, season, type: searchType === 'all' ? 'anime' : searchType, aliases: title !== raw ? raw : '' };
}
async function openManualFromSearch(query = searchQuery) {
  const seed = manualSeed(query);
  if(!await openForm())return;
  manualEnrichQuery = String(query || '').trim();
  const form = $('entryForm').elements;
  form.title.value = seed.title;
  form.type.value = seed.type;
  form.year.value = seed.year;
  form.season.value = seed.season;
  form.aliases.value = seed.aliases;
  ['entryType','entrySeason'].forEach(syncChoiceGroup);
  entryBaseline=entryDraftSignature();
  lastQueuedDraftSignature=entryBaseline;
  form.title.focus();
}
function enrichCandidate(items, query) {
  const q = String(query || '').trim();
  if (!q || !items?.length) return null;
  const normalized = normalizeText(q);
  const minimum = [...normalized].length <= 2 ? .9 : .68;
  return items.map(candidate => ({candidate, score:scoreEntry(candidate,q)}))
    .sort((a,b)=>b.score-a.score)
    .find(({candidate,score}) => {
      if (score < minimum) return false;
      const fields = [candidate.title,candidate.originalTitle,...(candidate.aliases || [])].filter(Boolean).map(normalizeText);
      return fields.some(field => field === normalized || field.includes(normalized) || normalized.includes(field));
    })?.candidate || null;
}
function mergeSourceMetadata(existing, remote) {
  const aliases = [...new Set([
    ...existing.aliases,
    ...(remote.aliases || []),
    remote.title && remote.title !== existing.title ? remote.title : '',
    remote.originalTitle && remote.originalTitle !== existing.title ? remote.originalTitle : ''
  ].filter(Boolean))].slice(0,24);
  return entry({...existing,
    sourceId:remote.sourceId,
    cover:existing.cover || remote.cover,
    originalTitle:existing.originalTitle || remote.originalTitle,
    aliases,
    format:existing.format || remote.format,
    year:existing.year || remote.year,
    season:existing.season || remote.season,
    region:existing.region || remote.region,
    studios:existing.studios.length ? existing.studios : remote.studios,
    airedAt:existing.airedAt || remote.airedAt,
    broadcastDay:existing.broadcastDay || remote.broadcastDay,
    broadcastTime:existing.broadcastTime || remote.broadcastTime,
    broadcastTimezone:existing.broadcastTimezone || remote.broadcastTimezone,
    total:existing.total || remote.total,
    score:remote.score ?? existing.score,
    genres:[...new Set([...existing.genres,...(remote.genres || [])])].slice(0,24),
    description:existing.description || remote.description,
    statusText:remote.statusText || existing.statusText,
    fetchedAt:new Date().toISOString()
  });
}
async function enrichManualEntry(id, query, type) {
  const matchQuery = manualSeed(query).title || String(query || '').trim();
  if (!matchQuery) return;
  const enabled = uiPreferences().sourceEnabled;
  const preferred = type === 'anime' ? ['bangumi','jikan','kitsu','wikipedia','ann'] : type === 'tv' ? ['tvmaze','wikidata','wikipedia'] : ['tvmaze','wikidata','wikipedia','bangumi'];
  const names = preferred.filter(name => enabled[name] !== false).slice(0,3);
  if (!names.length) return;
  const candidates = await Promise.allSettled(names.map(async name => {
    const data = await api(`/api/catalog/search?source=${name}&q=${encodeURIComponent(matchQuery)}&type=${type}`);
    return {name, candidate:enrichCandidate((data.results || []).map(entry),matchQuery)};
  }));
  const selected = candidates.map(x => x.status === 'fulfilled' ? x.value : null).filter(x => x?.candidate).sort((a,b)=>scoreEntry(b.candidate,matchQuery)-scoreEntry(a.candidate,matchQuery))[0];
  if (!selected?.candidate) return;
  const existing = library.entries.find(x => x.id === id);
  if (!existing || existing.sourceId || library.entries.some(x => x.id !== id && x.sourceId && x.sourceId === selected.candidate.sourceId)) return;
  if (await updateSavedEntry(id,latest=>mergeSourceMetadata(latest,selected.candidate)) && current?.id === id) openDetail(library.entries.find(item=>item.id===id),false);
}
function sourceLogo(name, label = '', extraClass = '') {
  const key = String(name || 'manual');
  const mark = SOURCE_MARKS[key] || String(label || key).slice(0, 2) || '手';
  const icon = SOURCE_META[key] ? `/api/source-icon?source=${encodeURIComponent(key)}` : '';
  return `<span class="source-logo ${esc(key)} ${esc(extraClass)}${icon ? ' has-icon' : ''}" title="${esc(label || NAMES[key] || key)}" aria-label="${esc(label || NAMES[key] || key)}">${icon ? `<img src="${esc(icon)}" alt="" loading="eager" data-source-icon="${esc(key)}" />` : ''}<span class="source-monogram" aria-hidden="true">${esc(mark)}</span></span>`;
}
const HEALTH_SOURCE_ORDER = [...SOURCE_KEYS];
function renderSourceRows(states = sourceHealth) {
  const list = $('sourceStatusList');
  if (!list) return;
  list.innerHTML = HEALTH_SOURCE_ORDER.map(name => {
    const v = states[name] || { state:'untested' };
    const meta = SOURCE_META[name] || {label:NAMES[name] || name};
    const testing = sourceTesting.has(name);
    const link = meta.href ? `<a class="source-link" href="${esc(meta.href)}" target="_blank" rel="noopener noreferrer">打开 ↗</a>` : '';
    const enabled = meta.searchable ? uiPreferences().sourceEnabled[name] !== false : true;
    const state = v.state || 'untested';
    const sourceControl = meta.seasonal
      ? '<span class="source-role">季度目录</span>'
      : meta.searchable
        ? `<label class="source-enabled"><input type="checkbox" data-source-toggle="${esc(name)}" ${enabled?'checked':''} />启用</label>`
        : '<span class="source-role">站点入口</span>';
    return `<article class="${enabled ? '' : 'is-disabled'}"><div>${sourceLogo(name,meta.label || name)}</div><div class="source-name-line"><b>${esc(meta.label || name)}</b>${link}</div><div class="source-health"><span class="health state-${esc(state)}${testing ? ' is-testing' : ''}" data-source-state="${esc(name)}">${testing?'测试中…':HEALTH[state] || state}</span><button class="text-btn source-refresh" data-refresh-source="${esc(name)}" ${testing?'disabled':''}>${testing?'测试中':'测试'}</button>${sourceControl}</div></article>`;
  }).join('');
}
function searchGroup(label, items, source = 'manual') {
  if (!items.length) return '';
  const sourceLabel = source === 'manual' ? '' : sourceLogo(source, label, 'search-group-source');
  const localClass = source === 'manual' ? ' is-local' : '';
  return `<section class="search-source-group${localClass}" aria-label="${esc(label)}搜索结果"><div class="remote-divider">${sourceLabel}<span>${esc(label)}</span><small>${items.length} 条</small></div><div class="search-source-results">${items.map(x => {
    const index = results.push(x)-1, saved = library.entries.some(e=>e.id===x.id || x.sourceId && e.sourceId===x.sourceId);
    const sourceLabel = NAMES[x.source] || x.source || '来源';
    const meta = [TYPE[x.type] || '其他', x.year || '年份未知', x.originalTitle || x.genres.slice(0,3).join(' / ')].filter(Boolean).join(' · ');
    return `<button class="result-item" data-result="${index}">${picture(x,'result-cover')}<div class="result-info"><b>${esc(x.title)}</b><span>${esc(meta)}</span></div>${sourceLogo(x.source || 'manual',sourceLabel,'result-source')}<span class="result-action">${saved?'已收录':'查看 ＋'}</span></button>`;
  }).join('')}</div></section>`;
}
function renderSearch() {
  results = []; selected = -1;
  if ($('quickAdd')) $('quickAdd').textContent = '添加作品';
  // An empty query is an invitation to search, not a second collection page.
  // Keep the workspace calm until the user enters a term; once a term exists,
  // local fuzzy matches still stay ahead of every network result.
  const local = searchQuery ? fuzzySearch(library.entries,searchQuery,{type:searchType}).slice(0,25).map(x=>x.entry) : [];
  let html = searchGroup('收藏',local,'manual');
  const failures=[];let pending=0, confirmedSources=0;
  for (const name of SEARCH_SOURCES) {
    const src = sourceResults[name]; if (!src) continue;
    if(src.state==='loading')pending++;
    if (['ok','cached'].includes(src.state)) confirmedSources++;
    const related = searchQuery ? fuzzySearch(src.results || [], searchQuery, {type:searchType}).map(x=>x.entry) : (src.results || []);
    const remote = related.filter(x=>!local.some(e=>e.id===x.id || (x.sourceId&&e.sourceId===x.sourceId)));
    html += searchGroup(NAMES[name] || name, remote, name);
    if(['unavailable','stale'].includes(src.state))failures.push({name,state:src.state,message:src.message || ''});
  }
  if(searchWaiting)html+=`<p class="search-query-state" role="status"><span class="search-spinner" aria-hidden="true"></span><span>搜索中</span></p>`;
  else if(pending)html+=`<p class="search-notice" role="status"><span class="search-spinner" aria-hidden="true"></span><span>${pending} 个来源查询中…</span></p>`;
  const sourcesDisabled = searchOnline && searchQuery && !Object.keys(sourceResults).length;
  if (sourcesDisabled) html += '<div class="search-source-state is-disabled" role="status"><div class="search-source-state-head"><div><b>联网来源已关闭</b><span>本地收藏仍可搜索；启用来源后可继续查找远程作品。</span></div><button type="button" class="text-btn search-source-retry" data-search-enable-sources>启用数据源</button></div></div>';
  if(failures.length)html+=`<section class="search-source-state" aria-label="联网来源状态"><div class="search-source-state-head"><div><b>${confirmedSources?'部分来源未响应':'联网来源暂不可用'}</b><span>${confirmedSources?'已保留可用结果；可以单独重试未响应的来源。':local.length?'已显示收藏中的匹配，远程结果暂时无法确认。':'远程结果暂时无法确认；可以重试或先手动记录。'}</span></div><button type="button" class="text-btn search-source-retry" data-search-retry-failed ${pending?'disabled':''}>重试 ${failures.length} 个来源</button></div><ul>${failures.map(({name,state,message})=>`<li><span class="search-source-signal state-${esc(state)}" aria-hidden="true"></span><b>${esc(NAMES[name] || name)}</b><span title="${esc(message || HEALTH[state] || '暂不可用')}">${esc(message || HEALTH[state] || '暂不可用')}</span></li>`).join('')}</ul></section>`;
  const hasRemote = results.some(x=>!local.some(e=>e.id===x.id || (x.sourceId&&e.sourceId===x.sourceId)));
  // Do not offer the fallback while the debounce or any provider is still
  // working. "Searching" and "no match" are mutually exclusive states.
  if(searchQuery && !searchWaiting && !pending && !local.length && !hasRemote) {
    const unavailable = failures.length && !confirmedSources;
    const localOnly = !searchOnline || sourcesDisabled;
    html+=`<div class="search-empty-actions ${unavailable?'is-unavailable':''}"><div><b>${unavailable?'来源恢复后可继续搜索':localOnly?'收藏中没有匹配作品':'可用来源中没有匹配作品'}</b><span>${unavailable?'先记录标题，稍后可自动补全资料。':!searchOnline?'按 Enter 查询联网来源，或先手动记录。':'可以先手动添加，后续仍能补全来源资料。'}</span></div><button class="primary-btn" data-manual>${unavailable?'先手动记录':'手动添加作品'}</button></div>`;
  }
  
  const resultsRegion = $('searchResults');
  resultsRegion.setAttribute('aria-busy', String(Boolean(searchWaiting || pending)));
  resultsRegion.innerHTML = html;
  renderSearchSeason();
}
function runSearch() {
  clearTimeout(searchTimer);
  searchAbort?.abort(); searchVersion++; searchOnline = false; sourceResults = {}; searchQuery = $('searchInput').value.trim().slice(0,100);
  $('clearSearch').hidden = !searchQuery;
  // Once a real keyword is present, the seasonal shelf is no longer useful;
  // cancel its in-flight catalogue request instead of letting it compete with
  // the keyword providers. Clearing the field can start it again on demand.
  if (searchQuery) cancelSearchSeasonRequest();
  renderSearch();
  if (!searchQuery && !searchSeasonLoaded) loadSearchSeason();
}
async function remoteSearch() {
  searchWaiting = false;
  runSearch(); if (!searchQuery) return;
  const version = searchVersion, q = searchQuery; searchAbort = new AbortController(); searchOnline = true;
  const enabled = uiPreferences().sourceEnabled;
  const names = SEARCH_SOURCES.filter(name => (searchType !== 'movie' || name !== 'tvmaze') && enabled[name]);
  if (!names.length) {
    renderSearch(); return;
  }
  const pending = [];
  names.forEach(name => {
    const cached = readSearchCache(name, q, searchType);
    if (cached) {
      sourceResults[name] = {...cached, state:'cached', results:(cached.results || []).map(entry)};
      return;
    }
    const retryAt = searchBackoff.get(name) || 0;
    if (retryAt > Date.now()) {
      sourceResults[name] = {state:'unavailable',message:'来源正在冷却，请稍后重试',results:[]};
      return;
    }
    sourceResults[name] = {state:'loading'};
    pending.push(name);
  });
  renderSearch();
  if (!pending.length) return;
  await querySearchSources(pending,version,q);
}
async function querySearchSources(pending, version, q) {
  let cursor = 0;
  const worker = async () => {
    while (version === searchVersion && cursor < pending.length) {
      const name = pending[cursor++];
      try {
        const data = await api(`/api/catalog/search?source=${name}&q=${encodeURIComponent(q)}&type=${searchType}`,{signal:searchAbort.signal});
        if (version!==searchVersion) return;
        const incoming = (data.results || []).map(entry);
        const normalized = {...data, results:incoming.length || !['unavailable','stale'].includes(data.state) ? incoming : sourceResults[name]?.results || []};
        writeSearchCache(name, q, searchType, normalized);
        if (['unavailable','stale'].includes(normalized.state)) searchBackoff.set(name, Date.now() + 20_000);
        else searchBackoff.delete(name);
        sourceResults[name] = normalized;
      } catch(e) {
        if (version!==searchVersion) return;
        // A failed provider is kept out of the next few rapid retries. This
        // matters most for 429 responses, which otherwise turn each typo into
        // another rate-limit hit.
        searchBackoff.set(name, Date.now() + 20_000);
        sourceResults[name] = {state:'unavailable',message:errorMessage(e,'查询失败'),results:sourceResults[name]?.results || []};
      }
      if(version===searchVersion) renderSearch();
    }
  };
  await Promise.all(Array.from({length:Math.min(SEARCH_CONCURRENCY,pending.length)}, () => worker()));
}
async function retryFailedSearchSources() {
  const names = SEARCH_SOURCES.filter(name => ['unavailable','stale'].includes(sourceResults[name]?.state));
  if (!searchQuery || !names.length) return;
  searchAbort?.abort();
  const version = ++searchVersion, q = searchQuery;
  searchAbort = new AbortController(); searchOnline = true; searchWaiting = false;
  names.forEach(name => {
    searchBackoff.delete(name);
    sourceResults[name] = {...sourceResults[name],state:'loading',message:''};
  });
  renderSearch();
  $('searchInput').focus({preventScroll:true});
  await querySearchSources(names,version,q);
}
async function health(source = '') {
  if (source && sourceTesting.has(source)) return;
  const testingSources = source === 'all' ? HEALTH_SOURCE_ORDER : source ? [source] : [];
  testingSources.forEach(name => sourceTesting.add(name));
  // Keep the page responsive: the previous status remains visible while the
  // requested probe is in flight, with only its own card changing to 测试中.
  if (testingSources.length) renderSourceRows(sourceHealth);
  let latest = null;
  try {
    const h = await api(source === 'all' ? '/api/health?source=all' : source ? `/api/health?source=${encodeURIComponent(source)}` : '/api/health');
    latest = h;
    sourceHealth = h.sources || sourceHealth;
    if ($('sourceConnectionState')) { $('sourceConnectionState').hidden = true; $('sourceConnectionState').innerHTML = ''; }
    const failed=Object.values(h.sources).some(x=>x.state==='unavailable');
    $('sourceStatus').textContent = failed ? '部分来源暂不可用' : Object.values(h.sources).some(x=>x.state==='ok') ? '最近查询已连接' : '随查询连接来源';
    document.querySelector('.pulse-dot').classList.toggle('warning',failed);
    renderSourceRows(sourceHealth);
    const storageText = loaded ? `${library.entries.length} 部作品 · ${Math.ceil(new TextEncoder().encode(JSON.stringify(library.entries)).length/1024)} KB` : '档案未读取';
    if ($('storageStats')) $('storageStats').textContent = storageText;
    if ($('sourceStorageStats')) $('sourceStorageStats').textContent = `封面缓存 ${Math.ceil(h.imageCacheBytes/1024)} KB`;
    if ($('coverCacheStats')) $('coverCacheStats').textContent = `${Math.ceil(h.imageCacheBytes/1024)} KB`;
  } catch(e) {
    $('sourceStatus').textContent = source ? '来源探测失败' : '本地服务未连接';
    // Keep the source inventory actionable when a probe fails. Replacing all
    // cards with one error paragraph would also remove every per-source test
    // button, forcing the user to leave and reopen the page to recover.
    if (!latest) renderSourceRows(sourceHealth);
    if (workspace === 'sources' && $('sourceConnectionState')) {
      $('sourceConnectionState').hidden = false;
      $('sourceConnectionState').innerHTML = `<span class="source-connection-mark" aria-hidden="true"></span><div><b>未能完成连接测试</b><p>保留上次状态；可以重新测试全部来源，也可以单独测试某一项。</p></div><button type="button" class="text-btn" data-refresh-source="all">重新测试</button>`;
    }
    // Connection state already stays on the source page and each source card.
    // A global toast would follow the user into another workspace and repeat
    // the same failure without adding a recovery action.
  }
  finally {
    testingSources.forEach(name => sourceTesting.delete(name));
    if (testingSources.length) renderSourceRows(sourceHealth);
  }
}
async function exportBackup() {
  return exportArchive(false);
}
function downloadJson(value, filename) {
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));
  link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportTransfer() {
  return exportArchive(true);
}
async function exportArchive(includeCovers) {
  if(dataOperation)return;
  if (!loaded || saving) throw Error('请等记录读取或保存完成后再导出');
  if(!beginDataOperation('export','fileTransferState'))return;
  const button = $(includeCovers?'exportTransfer':'exportData'),label=button.textContent;
  button.textContent = '正在整理…';
  const state=$('fileTransferState'); state.hidden=false;state.textContent=includeCovers?'正在整理作品与离线封面…':'正在整理作品资料…';state.focus();
  try {
    if(!await flushManagerNames(endDataOperation) || !await settingsSave.flush())throw Error('请先完成尚未保存的名称或设置');
    const task=commitTail.then(async()=>{
      return api('/api/migrations/export',{method:'POST',body:JSON.stringify({revision:library.revision,includeCovers})});
    });
    commitTail=task.catch(()=>{});
    const bundle=await task;
    downloadJson(bundle,`番渡${includeCovers?'完整迁移包':'资料备份'}-${new Date().toISOString().slice(0,10)}.json`);
    state.textContent=includeCovers?`完整迁移包已生成，包含 ${bundle.covers.entries.length} 张离线封面。`:'资料备份已生成。';
  } catch(e){state.textContent=`未导出：${e.message}`;}
  finally { endDataOperation(); button.textContent = label; await loadLocalBackups(); if(settingsTab==='data')button.focus(); }
}
let backupCatalog = null, pendingRestore = null, backupVersion = 0, pendingDeleteBackup = '';
let backupFeedback='',snapshotCreateAttempt=null,backupDeleteError='',backupDeleteStale=false,backupCatalogReady=false;
function migrationStorageBlocked(){return Boolean(migrationDiagnostics?.records.some(item=>item.id==='pending'&&item.state!=='missing'));}
function migrationHistoryBlocked(){return Boolean(migrationDiagnostics?.records.some(item=>item.id==='receipts'&&!['ok','missing'].includes(item.state)));}
function syncBackupAvailability() {
  syncNoticeBlocking();
  const busy=saving || Boolean(dataOperation) || pendingDataResult() || migrationStorageBlocked();
  for(const id of ['exportTransfer','exportData','importData'])$(id).disabled=!loaded || busy;
  if(migrationHistoryBlocked())$('importData').disabled=true;
  for(const id of ['exportCovers','importCovers','pruneCovers'])$(id).disabled=busy;
  const count=backupCatalog?.backups?.filter(item=>item.kind==='manual').length || 0;
  $('createSnapshot').disabled=!loaded || busy || !backupCatalogReady || $('backupState').dataset.busy==='true' || backupCatalog?.current.state!=='ok' || !snapshotCreateAttempt && count>=(backupCatalog?.limits?.manual || 20);
  $('refreshBackups').disabled=busy || $('backupState').dataset.busy==='true';
}
const backupKindLabel = kind => kind === 'auto' ? '自动备份' : kind === 'manual' ? '手动快照' : '恢复前原档';
function renderMigrationRecovery(){
  const records=migrationDiagnostics?.records||[],problem=records.some(item=>!['ok','missing'].includes(item.state))||records.some(item=>item.id==='pending'&&item.state==='ok');
  const busy=migrationDiagnosticBusy||Boolean(dataOperation),pending=migrationRepairAttempt?.pending;
  $('migrationRecovery').hidden=!problem&&!migrationDiagnosticError&&!migrationDiagnosticMessage&&!pending&&!storageRecoveryInline;
  $('migrationRecovery').classList.toggle('recovery-inline',storageRecoveryInline);$('closeStorageRecovery').hidden=!storageRecoveryInline;
  $('migrationRecoveryTitle').textContent=records.some(item=>item.id==='drafts'&&!['ok','missing'].includes(item.state))?'录入草稿需要处理':'恢复记录需要处理';
  $('migrationRecoveryState').textContent=migrationDiagnosticError||migrationDiagnosticMessage||(records.some(item=>item.state==='newer')?'记录来自较新版本，请升级番渡。原记录与当前档案均保留。':records.some(item=>item.state==='damaged')?'恢复记录损坏，原文件仍保留。可先导出诊断副本，再确认隔离损坏记录；不会撤销已经完成的操作。':problem?'上次迁移尚未结束，可继续恢复同一次任务。':'当前未发现记录异常，可以继续编辑。');
  const rows=records.filter(item=>item.state!=='missing'&&(item.id==='pending'||item.state!=='ok'));
  if(pending&&!rows.some(item=>item.id===migrationRepairAttempt.record.id))rows.push(migrationRepairAttempt.record);
  $('migrationRecoveryRecords').setAttribute('aria-busy',String(busy));
  $('migrationRecoveryRecords').innerHTML=rows.map(item=>{
    const confirming=migrationConfirmId===item.id||pending&&migrationRepairAttempt.record.id===item.id;
    const disabled=busy||!migrationDiagnosticReady||saving&&!saveCoordinator.unconfirmed||Boolean(pending&&migrationRepairAttempt.record.id!==item.id);
    return `<article class="migration-recovery-record" data-migration-record="${esc(item.id)}"><div><strong>${({pending:'待完成迁移',receipts:'迁移完成记录',drafts:'录入草稿'})[item.id]}</strong><small>${esc(item.state==='ok'?'内容有效，等待继续恢复':item.error||'等待核对隔离结果')}</small></div>${item.repairable?confirming?`<div class="migration-recovery-confirm"><p>${pending?'隔离结果尚未核对；继续使用原编号，不会再次移动其他记录。':'隔离这份损坏记录？原字节另存到数据目录，当前作品档案不变；隔离后不会自动重放该文件。'}</p><div>${pending?'':`<button type="button" class="text-btn" data-cancel-migration="${esc(item.id)}" ${busy?'disabled':''}>保留原记录</button>`}<button type="button" class="text-btn danger" data-confirm-migration="${esc(item.id)}" ${disabled?'disabled':''}>${pending?'核对隔离':'确认隔离'}</button></div></div>`:`<button type="button" class="text-btn" data-quarantine-migration="${esc(item.id)}" ${disabled?'disabled':''}>隔离损坏记录</button>`:''}</article>`;
  }).join('');
  $('refreshMigrationRecovery').disabled=busy||Boolean(pending);
  $('exportMigrationDiagnostic').disabled=busy;
  $('openMigrationFolder').disabled=busy;
  $('retryMigrationRecovery').hidden=!records.some(item=>item.id==='pending'&&item.state==='ok');
  $('retryMigrationRecovery').disabled=busy||Boolean(pending)||!migrationDiagnosticReady;
  syncBackupAvailability();if(backupCatalogReady)renderBackupList();
}
function reportEntryDraftRecovery(){
  if(entryDraftRecoveryNotice||storageRecoveryInline)return;
  entryDraftRecoveryNotice=toast('录入草稿暂时无法读取，原记录已保留。',{label:'检查恢复',persistent:true,allowWhileBlocked:true,run:async()=>{await showStorageRecordRecovery();entryDraftRecoveryNotice=null;return true;}});
}
async function showStorageRecordRecovery(){storageRecoveryInline=true;renderEntryRecovery();syncNoticeLocation();await loadMigrationDiagnostics();$('exportMigrationDiagnostic').focus({preventScroll:true});}
$('repairEntryDraftRecords').onclick=showStorageRecordRecovery;
$('closeStorageRecovery').onclick=()=>{storageRecoveryInline=false;storageRecoveryHome.insertBefore($('migrationRecovery'),storageRecoveryAnchor);renderMigrationRecovery();renderEntryRecovery();notificationFallback()?.focus({preventScroll:true});};
async function loadMigrationDiagnostics(){
  if(migrationDiagnosticBusy)return;
  migrationDiagnosticBusy=true;migrationDiagnosticReady=false;renderMigrationRecovery();
  try{migrationDiagnostics=await api('/api/migrations/diagnostics');migrationDiagnosticReady=true;migrationDiagnosticError='';}
  catch(error){migrationDiagnosticError=`未能检查迁移记录：${errorMessage(error)}。原文件未改动，请重新检查。`;}
  finally{migrationDiagnosticBusy=false;renderMigrationRecovery();}
}
async function migrationRecoveryAction(kind,task){
  if(dataOperation||migrationDiagnosticBusy)return false;
  if(kind!=='diagnostic-export'&&saving&&!saveCoordinator.unconfirmed)return false;
  dataOperation=kind;migrationDiagnosticBusy=true;syncDataOperationLock();renderMigrationRecovery();$('migrationRecoveryState').focus();
  try{await task();return true;}
  catch(error){migrationDiagnosticError=errorMessage(error);return false;}
  finally{migrationDiagnosticBusy=false;endDataOperation();renderMigrationRecovery();}
}
async function reloadAfterMigrationRecovery(){
  if(!loaded)await init();else{try{library=await api('/api/library');render();}catch{loaded=false;await init();}}
  await loadLocalBackups();
}
$('refreshMigrationRecovery').onclick=()=>{migrationDiagnosticMessage='';migrationConfirmId='';loadMigrationDiagnostics();};
$('openMigrationFolder').onclick=openDataFolder;
$('exportMigrationDiagnostic').onclick=()=>migrationRecoveryAction('diagnostic-export',async()=>{const result=await api('/api/migrations/diagnostics/export',{method:'POST'});downloadJson(result,`番渡恢复诊断-${new Date().toISOString().slice(0,10)}.json`);migrationDiagnosticError='';migrationDiagnosticMessage='诊断副本已导出，包含原始恢复记录与当前档案。';});
$('retryMigrationRecovery').onclick=async()=>{
  const completed=await migrationRecoveryAction('migration-recovery',async()=>{const result=await api('/api/migrations/diagnostics/retry',{method:'POST'});migrationDiagnostics=result.diagnostics;migrationDiagnosticReady=true;migrationDiagnosticError=result.error||'';migrationDiagnosticMessage=result.state==='completed'?'上次迁移已恢复完成，正在读取当前档案。':'';});
  if(completed&&!migrationDiagnosticError){
    if(importAttempt?.pending)await confirmImport();else if(snapshotRestoreAttempt?.pending)await restoreLocalBackup();else if(!saveCoordinator.unconfirmed)await reloadAfterMigrationRecovery();
  }
};
$('migrationRecoveryRecords').onclick=async event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.quarantineMigration){migrationConfirmId=button.dataset.quarantineMigration;renderMigrationRecovery();$('migrationRecoveryRecords').querySelector('[data-cancel-migration]')?.focus();return;}
  if(button.dataset.cancelMigration){const id=button.dataset.cancelMigration;migrationConfirmId='';renderMigrationRecovery();$('migrationRecoveryRecords').querySelector(`[data-quarantine-migration="${CSS.escape(id)}"]`)?.focus();return;}
  if(!button.dataset.confirmMigration)return;
  const id=button.dataset.confirmMigration,record=migrationDiagnostics?.records.find(item=>item.id===id);
  if(!migrationRepairAttempt){if(!record?.repairable||!migrationDiagnosticReady)return;migrationRepairAttempt={record,payload:{id,requestId:crypto.randomUUID(),token:record.token,currentToken:migrationDiagnostics.current.token},pending:false};}
  const completed=await migrationRecoveryAction('migration-quarantine',async()=>{
    let result;try{result=await api('/api/migrations/diagnostics/quarantine',{method:'POST',body:JSON.stringify(migrationRepairAttempt.payload)});}
    catch(error){migrationRepairAttempt.pending=!Number.isInteger(error.status)||error.status>=500;if(!migrationRepairAttempt.pending)migrationRepairAttempt=null;throw error;}
    if(result?.state!=='quarantined'||result.requestId!==migrationRepairAttempt.payload.requestId){migrationRepairAttempt.pending=true;throw Error('隔离响应无法核对，请继续核对同一次隔离');}
    migrationDiagnostics=result.diagnostics;migrationDiagnosticReady=true;migrationDiagnosticError='';migrationDiagnosticMessage=`原记录已保留为 ${result.preserved}。当前作品档案未被替换；待核对的原操作仍可使用原来的按钮继续。`;migrationRepairAttempt=null;migrationConfirmId='';
  });
  if(completed&&id==='drafts'){
    await loadEntryRecovery();
    if(activeDialog==='entryDialog'&&!editId&&formDraftRecord&&!entryAddAttempt){
      await formDraftSave.cancel();clearRecoveryTracking(formDraftRecord.id);formDraftRecord={id:crypto.randomUUID(),version:0};draftWriteVersions.set(formDraftRecord.id,0);
      formDraftSave.schedule({id:formDraftRecord.id,draft:recoveryFormDraft()});await formDraftSave.flush();
    }
  }
  if(completed&&!pendingDataResult()&&!saveCoordinator.unconfirmed)await reloadAfterMigrationRecovery();
};
function setBackupBusy(busy) {
  const state = $('backupState');
  if (!state) return;
  state.dataset.busy = busy ? 'true' : 'false';
  state.setAttribute('aria-busy','false');
}
function renderBackupList() {
  const list = $('backupList');
  if (!list) return;
  const scroll=list.scrollTop;
  const manualCount=(backupCatalog?.backups || []).filter(item=>item.kind==='manual').length;
  $('snapshotSummary').textContent=backupCatalog?`${manualCount} / ${backupCatalog.limits?.manual || 20} 手动 · ${backupCatalog.backups.length} 份`:'';
  const validCount = (backupCatalog?.backups || []).filter(item => item.state === 'ok').length;
  list.innerHTML = (backupCatalog?.backups || []).map(item => {
    const date = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', {hour12:false}) : '时间未知';
    const kind = backupKindLabel(item.kind);
    const pendingDelete = pendingDeleteBackup === item.id, pendingRecovery = pendingRestore?.selected?.id === item.id;
    const protectedCopy = item.state === 'ok' && validCount <= 1;
    const unavailable = item.state === 'newer' ? `需要新版番渡${item.formatVersion ? ` · v${item.formatVersion}` : ''}` : '不可恢复';
    const actions = pendingDelete
      ? `<span class="backup-delete-question">确定删除？</span><button class="text-btn danger-btn" data-confirm-delete-backup="${esc(item.id)}" ${backupDeleteStale?'disabled':''} aria-label="确认删除 ${esc(date)} 的${kind}">${backupDeleteError?'重试删除':'删除'}</button><button class="text-btn" data-cancel-delete-backup="${esc(item.id)}">取消</button>`
      : `<button class="text-btn" data-restore-backup="${esc(item.id)}" ${item.state !== 'ok' || saving || !backupCatalogReady || migrationHistoryBlocked() || migrationStorageBlocked() ? 'disabled' : ''} aria-label="${item.state === 'ok' ? '恢复' : unavailable} ${esc(date)} 的${kind}">${item.state === 'ok' ? '恢复' : item.state === 'newer' ? '需升级' : '不可恢复'}</button><button class="text-btn danger-btn" data-delete-backup="${esc(item.id)}" ${saving || protectedCopy || !backupCatalogReady ? 'disabled' : ''} ${protectedCopy ? 'title="至少保留一份可恢复快照"' : ''} aria-label="删除 ${esc(date)} 的${kind}">删除</button>`;
    const current = backupCatalog?.current;
    const replacement = current?.state === 'ok' ? `当前 ${current.count} 部及设置将被替换` : current?.state === 'newer' ? '当前较新版档案将被替换' : current?.state === 'corrupt' ? '当前损坏档案将被替换' : '当前档案将被替换';
    const recovery = pendingRecovery ? `<div class="backup-restore-inline"><p>恢复 ${item.count} 部作品；${replacement}，恢复前原档另存。</p><p id="backupRestoreStatus" class="backup-action-state" role="status" tabindex="-1" data-error="${Boolean(pendingRestore.error)}" ${pendingRestore.error || dataOperation==='snapshot-restore'?'':'hidden'}>${esc(pendingRestore.error || '正在恢复快照…')}</p><div><button class="text-btn" data-cancel-restore-backup="${esc(item.id)}">取消</button><button class="primary-btn" data-confirm-restore-backup="${esc(item.id)}" aria-describedby="backupRestoreStatus" ${pendingRestore.stale?'disabled':''}>${snapshotRestoreAttempt?.pending?'继续完成恢复':pendingRestore.error?'重试恢复':'确认恢复'}</button></div></div>` : '';
    return `<article class="backup-row${pendingRecovery ? ' is-restoring' : ''}${item.state === 'ok' ? '' : ' is-invalid'}" data-backup-row="${esc(item.id)}"><div class="backup-row-head"><span class="backup-kind backup-kind-${esc(item.kind)}">${esc(kind)}</span><time datetime="${esc(item.createdAt || '')}">${esc(date)}</time></div><strong>${item.state === 'ok' ? `${item.count} 部作品` : unavailable}</strong>${pendingRecovery ? '' : `<div class="backup-actions" role="group" aria-label="${esc(date)} 的${kind}操作">${actions}</div>`}${pendingDelete&&backupDeleteError?`<p class="backup-action-error" role="status">${esc(backupDeleteError)}${backupDeleteStale?'。请刷新后重新核对确认。':'。可重试当前删除。'}</p>`:''}${recovery}</article>`;
  }).join('');
  list.scrollTop=scroll;syncDataOperationLock();
}
async function loadLocalBackups() {
  void loadMigrationDiagnostics();
  if(dataOperation || pendingDataResult())return;
  const version = ++backupVersion;
  backupCatalogReady=false;
  pendingRestore = null; pendingDeleteBackup = '';
  snapshotRestoreAttempt=null;backupDeleteError='';backupDeleteStale=false;
  $('exportTransfer').disabled = !loaded || saving; $('exportData').disabled = !loaded || saving; $('importData').disabled = !loaded || saving; $('createSnapshot').disabled = !loaded || saving;
  $('exportCovers').disabled = saving; $('importCovers').disabled = saving; $('pruneCovers').disabled = saving;
  if(!backupCatalog){$('backupList').replaceChildren();$('snapshotSummary').textContent='';}
  setBackupBusy(true); $('backupState').textContent = '读取中…'; $('backupState').dataset.state='';syncBackupAvailability();renderBackupList();
  try {
    const catalog = await api('/api/backups');
    if (version !== backupVersion) return;
    backupCatalog = catalog;backupCatalogReady=true;
    $('createSnapshot').textContent=snapshotCreateAttempt?'重试创建':'创建快照';
    const manualCount = catalog.backups.filter(item => item.kind === 'manual').length, manualLimit = catalog.limits?.manual || 20, atLimit = manualCount >= manualLimit;
    $('createSnapshot').disabled = !loaded || saving || catalog.current.state !== 'ok' || atLimit && !snapshotCreateAttempt;
    $('createSnapshot').title = atLimit ? '请先删除旧的手动快照' : '';
    $('backupState').textContent = backupFeedback || (catalog.current.state === 'newer' ? `当前档案需要新版番渡${catalog.current.formatVersion ? `（格式 v${catalog.current.formatVersion}）` : ''}，已保持只读。` : catalog.current.state === 'corrupt' ? '当前档案损坏，已暂停保存。' : catalog.current.state === 'missing' ? '当前档案尚未建立。' : atLimit ? '已达手动快照上限' : catalog.backups.length ? '' : '暂无快照');
    renderBackupList();
  } catch (e) { if (version === backupVersion) {$('backupState').textContent=`未读取：${errorMessage(e)}${backupCatalog?'。上次列表仍保留，请刷新后再核对。':''}`;$('backupState').dataset.state='error';renderBackupList();} }
  finally { if (version === backupVersion) { setBackupBusy(false); syncBackupAvailability(); } syncDataOperationLock(); }
}
async function createLocalSnapshot() {
  if (!loaded || saving || dataOperation || pendingDataResult() || !backupCatalogReady || $('backupState').dataset.busy==='true') return;
  if (dirty || formDirty || settingsSave.dirty || managerNamesDirty()) return toast('请先完成尚未保存的修改。');
  const button = $('createSnapshot');
  if(!backupCatalog)return;
  snapshotCreateAttempt ||= {requestId:crypto.randomUUID(),currentToken:backupCatalog.current.token};
  if(!beginDataOperation('snapshot-create','backupState'))return;
  ++backupVersion;backupFeedback='';$('backupState').dataset.state='';
  setBackupBusy(true);$('backupState').textContent='正在创建快照…';$('backupState').focus();
  let finished=false;
  try {
    backupCatalog=await api('/api/backups/create', { method:'POST',body:JSON.stringify(snapshotCreateAttempt) });
    snapshotCreateAttempt=null;finished=true;button.textContent='创建快照';
    toast('手动快照已创建。');
  } catch (e) {
    backupFeedback=`创建未确认：${errorMessage(e)}。重试将确认同一次创建，不会重复生成快照。`;
    if(e.status===409){snapshotCreateAttempt=null;backupCatalogReady=false;backupFeedback=`未创建：${errorMessage(e)}。请刷新后再创建。`;renderBackupList();}
    $('backupState').textContent=backupFeedback;$('backupState').dataset.state='error';button.textContent='重试创建';
  } finally {
    setBackupBusy(false);endDataOperation();
    if(finished)await loadLocalBackups();
    (button.disabled ? $('refreshBackups') : button).focus();
  }
}
function askDeleteLocalBackup(id) {
  if (saving || dataOperation || pendingDataResult() || !backupCatalogReady) return;
  const selected = backupCatalog?.backups.find(item => item.id === id);
  if (!selected) return;
  pendingRestore = null; pendingDeleteBackup = pendingDeleteBackup === id ? '' : id;
  snapshotRestoreAttempt=null;backupDeleteError='';backupDeleteStale=false;
  renderBackupList();
  const target = pendingDeleteBackup ? 'confirm-delete-backup' : 'delete-backup';
  $('backupList').querySelector(`[data-${target}="${CSS.escape(id)}"]`)?.focus();
}
async function deleteLocalBackup(id) {
  if (saving || dataOperation || pendingDataResult() || backupDeleteStale || !backupCatalogReady) return;
  const selected = backupCatalog?.backups.find(item => item.id === id);
  if (!selected) return;
  beginDataOperation('snapshot-delete','backupState');++backupVersion;backupDeleteError='';
  setBackupBusy(true); $('backupState').textContent = '删除中…';
  $('backupState').focus();let finished=false;
  try {
    await api('/api/backups/delete', { method:'POST', body:JSON.stringify({id:selected.id, token:selected.token}) });
    finished=true;pendingDeleteBackup='';
    toast('快照已删除。');
  } catch (e) {backupDeleteError=`删除未确认：${errorMessage(e)}`;backupDeleteStale=e.status===409;}
  finally {
    setBackupBusy(false);$('backupState').textContent=backupFeedback;endDataOperation();
    if(finished){await loadLocalBackups();$('refreshBackups').focus();}
    else {renderBackupList();$('backupList').querySelector(`[data-${backupDeleteStale?'cancel-delete-backup':'confirm-delete-backup'}="${CSS.escape(id)}"]`)?.focus();}
  }
}
async function exportCovers() {
  if(saving || !beginDataOperation('covers-export','coverTransferState'))return;
  $('coverTransferState').textContent='正在导出封面…';$('coverTransferState').focus();
  try {
    const bundle = await api('/api/covers/export');
    downloadJson(bundle,`番渡封面缓存-${new Date().toISOString().slice(0,10)}.json`);
    $('coverTransferState').textContent = `已导出 ${bundle.entries.length} 张封面。`;
  }catch(e){$('coverTransferState').textContent=`未导出：${e.message}`;}
  finally{endDataOperation();await loadLocalBackups();$('exportCovers').focus();}
}
async function pruneCovers() {
  const button = $('pruneCovers');
  if (!button || saving || !beginDataOperation('covers-prune','coverTransferState')) return;
  $('coverTransferState').textContent = '整理中…';
  $('coverTransferState').focus();
  try {
    const result = await api('/api/covers/prune',{method:'POST'});
    $('coverTransferState').textContent = result.removed ? `已清理 ${result.removed} 张无用封面，当前 ${result.items} 张。` : `没有无用封面，当前 ${result.items} 张。`;
    health();
  } catch (e) { $('coverTransferState').textContent = `清理失败：${e.message}`; }
  finally { endDataOperation(); await loadLocalBackups();button.focus(); }
}
async function importCovers(file) {
  if (!file || saving || dataOperation || pendingDataResult()) return;
  if (file.size > 48 * 1024 * 1024) { $('coverTransferState').textContent='封面缓存包过大。'; return; }
  if(!beginDataOperation('covers-import','coverTransferState'))return;
  $('coverTransferState').textContent='校验并导入中…';$('coverTransferState').focus();
  try {
    const result = await api('/api/covers/import',{method:'POST',body:await file.text()});
    $('coverTransferState').textContent=`已导入 ${result.added + result.updated} 张封面，当前缓存 ${result.items} 张。`;
    health();
  } catch (e) { $('coverTransferState').textContent=`导入失败：${e.message}`; }
  finally { $('importCovers').value=''; endDataOperation();await loadLocalBackups();$('exportCovers').focus(); }
}
function prepareLocalRestore(id) {
  if (saving || dataOperation || pendingDataResult() || !backupCatalogReady) return;
  if (dirty || formDirty || settingsSave.dirty || managerNamesDirty()) return toast('请先完成尚未保存的修改。');
  const catalog = backupCatalog, selected = catalog?.backups.find(x => x.id === id && x.state === 'ok');
  if (!selected) return;
  pendingDeleteBackup = ''; snapshotRestoreAttempt=null;pendingRestore = {catalog,selected,error:'',stale:false}; renderBackupList();
  $('backupList').querySelector(`[data-cancel-restore-backup="${CSS.escape(id)}"]`)?.focus();
}
async function restoreLocalBackup() {
  if (!pendingRestore || pendingRestore.stale || saving || dataOperation || importAttempt?.pending) return;
  if (dirty || formDirty || settingsSave.dirty || managerNamesDirty()) return toast('请先完成尚未保存的修改。');
  const {catalog,selected} = pendingRestore;
  snapshotRestoreAttempt ||= {payload:{requestId:crypto.randomUUID(),id:selected.id,token:selected.token,currentToken:catalog.current.token},pending:false};
  if(!beginDataOperation('snapshot-restore','backupRestoreStatus'))return;
  ++backupVersion;
  pendingRestore.error='';setBackupBusy(true);$('backupState').textContent='';renderBackupList();$('backupRestoreStatus').focus();
  let finished=false;
  try {
    const task=commitTail.then(async()=>{
      let result;
      try{result=await api('/api/backups/restore',{method:'POST',body:JSON.stringify(snapshotRestoreAttempt.payload)});}
      catch(error){
        $('backupRestoreStatus').textContent='正在确认恢复结果…';
        let status;
        try{status=await api(`/api/migrations/status?id=${encodeURIComponent(snapshotRestoreAttempt.payload.requestId)}`);}
        catch{snapshotRestoreAttempt.pending=true;throw error;}
        if(status.state==='committed')result=status.result;
        else {snapshotRestoreAttempt.pending=status.state==='pending' || error.migrationPending || !Number.isInteger(error.status);if(!snapshotRestoreAttempt.pending)snapshotRestoreAttempt=null;throw error;}
      }
      library=result.library;loaded=true;page=1;
      return result;
    });
    commitTail=task.catch(()=>{});const result=await task;
    snapshotRestoreAttempt=null;finished=true;
    if (current) closeDetail();
    render(); loadGeneralSettings(); health();
    toast(result.preserved ? '快照已恢复，恢复前原档已保留。' : '快照已恢复。');
  } catch (e) {
    pendingRestore.stale=e.status===409 && !snapshotRestoreAttempt?.pending;
    if(e.migrationPending)void loadMigrationDiagnostics();
    pendingRestore.error=`${snapshotRestoreAttempt?.pending?'恢复结果尚未确认，当前快照和确认版本已锁定。':'未恢复。'}${errorMessage(e)}${pendingRestore.stale?' 请刷新列表后重新核对确认。':snapshotRestoreAttempt?.pending?' 请继续完成同一次恢复。':' 可重试当前恢复。'}`;
  } finally {
    setBackupBusy(false);endDataOperation();
    if(finished){clearImportReview();await loadLocalBackups();$('refreshBackups').focus();}
    else {renderBackupList();$('backupList').querySelector(`[data-${pendingRestore.stale?'cancel-restore-backup':'confirm-restore-backup'}="${CSS.escape(selected.id)}"]`)?.focus();}
  }
}
let importBundle = null, importVersion = 0;
function syncDataOperationLock() {
  syncNoticeBlocking();
  if(!dataOperation && !pendingDataResult())return;
  $('dataDialog').querySelectorAll('button,input,select,textarea').forEach(control=>{
    if(control.closest('#toasts,#migrationRecovery'))return;
    if(!dataLockedControls.has(control))dataLockedControls.set(control,control.disabled);
    control.disabled=!(!dataOperation && (importAttempt?.pending && control.id==='importConfirm' || snapshotRestoreAttempt?.pending && control.dataset.confirmRestoreBackup===snapshotRestoreAttempt.payload.id));
  });
}
function beginDataOperation(kind, focusId = 'importState') {
  if(saveCoordinator.unconfirmed)return false;
  if(dataOperation || pendingDataResult() && !(kind==='import'&&importAttempt?.pending || kind==='snapshot-restore'&&snapshotRestoreAttempt?.pending))return false;
  dataOperation=kind; dataOperationFocus=focusId; syncDataOperationLock(); return true;
}
function endDataOperation() {
  dataOperation='';
  for(const [control,disabled] of dataLockedControls)if(control.isConnected)control.disabled=disabled;
  dataLockedControls.clear();
  syncBackupAvailability();
  syncDataOperationLock();
}
function setImportState(text, state = '') {
  const node=$('importState');
  node.textContent=text; node.hidden=!text; node.dataset.state=state;
  // Keep the live progress outside the busy options subtree so assistive
  // technology can announce each stage instead of deferring until completion.
  $('importOptions').setAttribute('aria-busy',String(state==='busy'));
}
function clearImportReview() {
  if(dataOperation || pendingDataResult())return;
  importAttempt=null;
  importBundle = null; ++importVersion;
  setImportState('');
  $('importReview').hidden = true; $('importFileName').textContent = ''; $('importPreview').textContent = '';
  $('importPreview').setAttribute('aria-busy','false'); $('importOptions').hidden = true; $('importConfirm').hidden = true; $('importConfirm').disabled = false;
  $('importMode').value = 'merge'; syncChoiceGroup('importMode');
  $('importLayout').checked = false; $('importLayout').disabled = false; $('importData').value = '';
}
function importPreview() {
  if(dataOperation || pendingDataResult())return;
  importAttempt=null;
  setImportState('');
  $('importConfirm').hidden = true; $('importConfirm').disabled = true;
  if (!importBundle) return;
  const replace = $('importMode').value === 'replace';
  try {
    const result = replace ? {entries:importBundle.entries,added:importBundle.entries.length,skipped:0} : mergeBackup(library.entries,importBundle.entries);
    const coverSummary = importBundle.kind === 'transfer' ? `；迁移包同时包含 ${importBundle.coverCount} 张离线封面` : '';
    $('importPreview').textContent = replace
      ? `完整恢复：当前 ${library.entries.length} 条记录将替换为备份中的 ${result.entries.length} 条。恢复前会另存原档保护副本${coverSummary}。`
      : `合并导入：新增 ${result.added} 条，跳过 ${result.skipped} 条重复记录；现有记录保持不变${coverSummary}。`;
    $('importConfirm').textContent = replace ? '确认完整恢复' : '确认合并';
    $('importConfirm').hidden = false; $('importConfirm').disabled = false;
    $('importLayout').disabled = !importBundle.settings;
    if (!importBundle.settings) $('importLayout').checked = false;
  } catch(e) { $('importPreview').textContent=e.message; }
}
async function readBackup(file) {
  if(dataOperation || pendingDataResult())return;
  importAttempt=null;
  $('fileTransferState').hidden=true;
  const version=++importVersion;
  importBundle=null; $('importConfirm').hidden=true; $('importConfirm').disabled=true; $('importOptions').hidden=true;
  if(!file){clearImportReview();return;}
  setImportState('');
  $('importReview').hidden=false; $('importFileName').textContent=file.name; $('importPreview').textContent='读取中…'; $('importPreview').setAttribute('aria-busy','true');
  try {
    if(file.size>MAX_TRANSFER_BYTES) throw Error('导入文件过大');
    const bundle=await parsePortableBundle(await file.text());
    if(version!==importVersion)return;
    importBundle=bundle; $('importOptions').hidden=false; importPreview();
  } catch(e) { if(version===importVersion){$('importPreview').textContent='未导入文件。';setImportState(e.message,'error');} }
  finally { if(version===importVersion){$('importPreview').setAttribute('aria-busy','false');$('importData').value='';} }
}
async function confirmImport() {
  if(!importBundle || dataOperation)return;
  if(!loaded || saving){setImportState('请等待档案读取或当前保存完成后重试。','error');return;}
  const bundle=importBundle, replace=$('importMode').value==='replace', restoreSettings=$('importLayout').checked;
  if(!beginDataOperation('import'))return;
  setImportState('正在保存待完成的修改…','busy'); $('importState').focus();
  let finished=false;
  try {
    if(!await flushManagerNames(endDataOperation)){
      setImportState('导入未开始，请先修正尚未保存的名称。','error'); return;
    }
    if(!await settingsSave.flush()){
      endDataOperation(); activateSettingsTab('general'); $('retrySettings').focus();
      setImportState('导入未开始，请先重试外观设置的保存。','error'); return;
    }
    if(noteComposing || formComposing || !await noteSave.flush() || !await entrySave.flush())throw Error('尚有未保存的作品修改，请先完成保存');
    const task=commitTail.then(async()=>{
      // Retain exactly the confirmed intent across uncertain responses. Never
      // recompute a merge or use a new id for an already accepted request.
      if(!importAttempt){
        importAttempt={payload:{requestId:crypto.randomUUID(),revision:library.revision,
          entries:replace?bundle.entries:mergeBackup(library.entries,bundle.entries).entries,
          settings:restoreSettings&&bundle.settings?bundle.settings:library.settings,covers:bundle.covers},pending:false};
      }
      setImportState(bundle.covers?'正在导入作品与离线封面…':'正在导入作品资料…','busy');
      let result;
      try{result=await api('/api/migrations/import',{method:'POST',body:JSON.stringify(importAttempt.payload)});}
      catch(error){
        setImportState('正在确认导入结果…','busy');
        let status;
        try{status=await api(`/api/migrations/status?id=${encodeURIComponent(importAttempt.payload.requestId)}`);}
        catch{importAttempt.pending=true;throw error;}
        if(status.state==='committed')result=status.result;
        else {
          // Unknown after a transport failure is not proof of rejection: the
          // server may still be receiving the original request body. Keep its
          // id until a retry can establish a definitive outcome.
          importAttempt.pending=status.state==='pending' || error.migrationPending || !Number.isInteger(error.status);
          if(!importAttempt.pending)importAttempt=null;
          throw error;
        }
      }
      library=result.library;loaded=true;page=1;
      importAttempt=null;render();
      toast(bundle.covers?`${replace?'迁移包已恢复':'迁移包已合并'}，包含 ${result.coverCount} 张离线封面`:replace?'备份已恢复':'备份已合并');
      return true;
    });
    commitTail=task.catch(()=>{});
    if(!await task)throw Error('档案尚未读取，暂时不能导入');
    finished=true;
  } catch(e) {
    setImportState(`${importAttempt?.pending?'导入结果尚未确认，已锁定当前文件和选项。':'未完成导入。'}${errorMessage(e).replace(/[。.!！]+$/,'')}。${importAttempt?.pending?'请继续完成同一次导入；恢复前不会接受其他修改。':'文件与选项仍保留，可重试。'}`,'error');
  } finally {
    endDataOperation(); $('importOptions').setAttribute('aria-busy','false');
    if(finished){clearImportReview();loadGeneralSettings();renderListManager();renderTagManager();renderSeriesManager();health();}
    else if(settingsTab==='data'){
      $('importConfirm').disabled=false;
      $('importConfirm').textContent=importAttempt?.pending?'继续完成导入':replace?'重试完整恢复':'重试合并'; $('importConfirm').focus();
    }
    await loadLocalBackups();
  }
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button, a'); if (!b) return;
  if (b.dataset.entrySeriesOption) {
    setEntrySeries(b.dataset.entrySeriesOption,true); $('entrySeriesQuery')?.focus(); return;
  }
  if (b.dataset.entryTagRemove) {
    renderEntryTagPicker(entryTagValues().filter(tag => tag !== b.dataset.entryTagRemove));
    queueEntryEdit(); $('entryTagInput')?.focus(); return;
  }
  if (b.dataset.entryTagAdd) {
    addEntryTag(b.dataset.entryTagAdd); $('entryTagInput')?.focus(); return;
  }
  if (b.hasAttribute('data-choice')) { chooseSetting(b); return; }
  if (b.dataset.restoreBackup) { prepareLocalRestore(b.dataset.restoreBackup); return; }
  if (b.dataset.cancelRestoreBackup) { if(dataOperation || pendingDataResult())return;const id=b.dataset.cancelRestoreBackup; pendingRestore=null;snapshotRestoreAttempt=null; renderBackupList(); $('backupList').querySelector(`[data-restore-backup="${CSS.escape(id)}"]`)?.focus(); return; }
  if (b.dataset.confirmRestoreBackup) { if(pendingRestore?.selected?.id===b.dataset.confirmRestoreBackup)await restoreLocalBackup(); return; }
  if (b.dataset.deleteBackup) { askDeleteLocalBackup(b.dataset.deleteBackup); return; }
  if (b.dataset.confirmDeleteBackup) { await deleteLocalBackup(b.dataset.confirmDeleteBackup); return; }
  if (b.dataset.cancelDeleteBackup) { if(dataOperation || pendingDataResult())return;pendingDeleteBackup = '';backupDeleteError='';backupDeleteStale=false; renderBackupList(); $('backupList').querySelector(`[data-delete-backup="${CSS.escape(b.dataset.cancelDeleteBackup)}"]`)?.focus(); return; }
  if (b.dataset.refreshSource) { health(b.dataset.refreshSource); return; }
  if (b.id === 'toggleSelection') { toggleSelectionMode(); return; }
  if (b.id === 'batchSelectVisible') { toggleVisibleSelection(); return; }
  if (b.id === 'clearSelection') { clearSelection(); return; }
  if (b.id === 'batchAddList') {
    const listId = $('batchListSelect').value, ids = new Set(selectedEntries().map(x => x.id)), target = uiPreferences().lists.find(list => list.id === listId);
    if (!target || !ids.size) return;
    if (await commitCommand({type:'batch-list',listId,ids:[...ids]})) { selectedIds.clear(); $('batchListSelect').value=''; render(); }
    return;
  }
  if (b.hasAttribute('data-search-open')) { openSearch(); return; }
  if (b.dataset.settingsTab) { activateSettingsTab(b.dataset.settingsTab); return; }
  if (b.hasAttribute('data-tools-home')) {
    renderToolsHome();
    $('toolsView')?.scrollIntoView({behavior:'smooth', block:'start'});
    return;
  }
  if (b.dataset.toolHub) {
    toolTabs(b.dataset.toolHub);
    document.querySelector(`[data-tool-tab="${CSS.escape(b.dataset.toolHub)}"]`)?.scrollIntoView({block:'nearest', inline:'nearest'});
    return;
  }
  if (b.dataset.toolTab) { toolTabs(b.dataset.toolTab); return; }
  if (b.dataset.seasonYear) {
    const year = Number(b.dataset.seasonYear), nextQuarter = normalizeYucQuarter(year, seasonQuery.season);
    if (nextQuarter.year === seasonQuery.year && nextQuarter.season === seasonQuery.season) return;
    cancelSeasonRequest(); seasonLoaded = false; seasonItems = []; seasonHasNext = false; seasonTotal = null; seasonFetched = ''; seasonQuery = nextQuarter; seasonError = ''; loadSeason(); return;
  }
  if (b.dataset.seasonQuarter) {
    const year = seasonQuery.year, season = b.dataset.seasonQuarter;
    if (season === seasonQuery.season) return;
    if (!isYucQuarterAvailable(year, season)) { seasonError = 'Yuc 尚未收录该季度'; seasonLoaded = true; seasonItems = []; seasonHasNext = false; seasonTotal = null; seasonFetched = ''; seasonSource = ''; renderSeason(); return; }
    cancelSeasonRequest(); seasonLoaded = false; seasonItems = []; seasonHasNext = false; seasonTotal = null; seasonFetched = ''; seasonQuery = { year, season }; loadSeason(); return;
  }
  if (b.hasAttribute('data-season-day')) { seasonDay=b.dataset.seasonDay;renderSeason();return; }
  if (b.hasAttribute('data-timeline-decade')) { timelineDecade=b.dataset.timelineDecade;timelineShown=120;timelineKey='';renderTimeline();return; }
  if (b.id === 'timelineMore') { timelineShown += 120; renderTimeline(); return; }
  if (b.id === 'catalogMore') { catalogShown += CATALOG_BATCH; renderCatalog(); return; }
  if (b.dataset.catalogFilter) { catalogFilters[b.dataset.catalogFilter] = b.dataset.value || ''; catalogShown = CATALOG_BATCH; renderCatalog(); return; }
  if (b.dataset.toolOpen) { const item=[...library.entries,...seasonItems,...searchSeasonItems].find(x=>x.id===b.dataset.toolOpen); if(item) openDetail(item); return; }
  if (b.hasAttribute('data-search-season-retry')) { searchSeasonLoaded = false; loadSearchSeason(); return; }
  if (b.hasAttribute('data-search-retry-failed')) { await retryFailedSearchSources(); return; }
  if (b.hasAttribute('data-search-enable-sources')) { openWorkspace('sources'); return; }
  if (b.dataset.layoutMode) {
    const mode = b.dataset.layoutMode;
    if (uiPreferences().view !== mode) { page = 1; savePreferences({view:mode}); }
    return;
  }
  if (b.hasAttribute('data-catalog-reset')) { catalogFilters = { year:'', season:'', region:'', list:'', type:'' }; catalogShown = CATALOG_BATCH; renderCatalog(); return; }
  if (b.id === 'loadSeason' || b.id === 'retrySeason' || b.id === 'moreSeason') { await loadSeason(b.id==='moreSeason'); return; }
  if (b.hasAttribute('data-source-open')) { openWorkspace('sources'); return; }
  if (b.hasAttribute('data-tools-open')) { openWorkspace('tools'); return; }
  if (b.id === 'addList') {
    const raw=$('newListName').value, label = raw.normalize('NFKC').trim().replace(/\s+/g,' '); if (!label) return toast('请输入列表名称。');
    const prefs = uiPreferences();
    if (prefs.lists.length >= MAX_LISTS) return toast(`最多可创建 ${MAX_LISTS} 个列表。`);
    if (prefs.lists.some(x => x.label === label)) return toast('列表名称已存在。');
    const id=`list-${crypto.randomUUID()}`;b.disabled=true;
    const ok=await commitCommand({type:'create-list',id,label},'',{render:false});
    b.disabled=false;
    if(ok){if($('newListName').value===raw)$('newListName').value='';renderNav();if(workspace==='collection')render();renderListManager();}
    return;
  }
  if(b.dataset.retryManagerName){await managerNames.get(b.dataset.retryManagerName)?.save.flush();return;}
  if (b.dataset.deleteList) {
    const prefs=uiPreferences(), target=prefs.lists.find(x=>x.id===b.dataset.deleteList);
    if(!target || target.kind==='all') return toast('收藏总入口不能删除。');
    pendingListDelete = pendingListDelete === target.id ? '' : target.id;
    pendingTagDelete = ''; pendingSeriesDelete = '';
    renderListManager();
    (pendingListDelete ? document.querySelector(`[data-confirm-delete-list="${CSS.escape(target.id)}"]`) : document.querySelector(`[data-delete-list="${CSS.escape(target.id)}"]`))?.focus();
    return;
  }
  if (b.dataset.cancelDeleteList) {
    const id = b.dataset.cancelDeleteList; pendingListDelete = ''; renderListManager();
    document.querySelector(`[data-delete-list="${CSS.escape(id)}"]`)?.focus(); return;
  }
  if (b.dataset.confirmDeleteList) {
    const prefs=uiPreferences(), target=prefs.lists.find(x=>x.id===b.dataset.confirmDeleteList);
    if(!target || target.kind==='all') return;
    setManagerDeleteBusy(b,true);
    const deleted=await commitCommand({type:'delete-list',id:target.id,expectedLabel:target.label},'',{render:false});
    if(deleted) {
      managerDeleteErrors.delete(managerNameKey('list',target.id));
      pendingListDelete = '';const name=managerNames.get(managerNameKey('list',target.id));if(name)name.removed=true;managerNames.delete(managerNameKey('list',target.id));
      const activeDeleted = view === target.id;
      if (activeDeleted) view = prefs.lists.find(x=>x.kind==='all')?.id || 'library';
      renderNav();
      if (workspace === 'collection') render();
      renderListManager();
    } else {
      managerDeleteErrors.set(managerNameKey('list',target.id),'删除失败，可重试');renderListManager();
    }
    setManagerDeleteBusy(b,false);
    return;
  }
  if (b.id === 'addTag') {
    const raw=$('newTagName').value,label=cleanEntryTag(raw); if(!label)return toast('请输入标签名称。');
    const prefs=uiPreferences(), normalized=normalizeText(label);
    if(prefs.tags.length>=MAX_MANAGED_TAGS)return toast(`最多可管理 ${MAX_MANAGED_TAGS} 个标签。`);
    if(allTags().some(value=>normalizeText(value)===normalized))return toast('标签已存在。');
    b.disabled=true;
    const ok=await commitCommand({type:'create-tag',label},'',{render:false});
    b.disabled=false;
    if(ok){ if($('newTagName').value===raw)$('newTagName').value=''; renderTagManager(); }
    return;
  }
  if (b.dataset.deleteTag) {
    const t=b.dataset.deleteTag; pendingTagDelete = pendingTagDelete === t ? '' : t;
    pendingListDelete = ''; pendingSeriesDelete = ''; renderTagManager();
    (pendingTagDelete ? document.querySelector(`[data-confirm-delete-tag="${CSS.escape(t)}"]`) : document.querySelector(`[data-delete-tag="${CSS.escape(t)}"]`))?.focus(); return;
  }
  if (b.dataset.cancelDeleteTag) {
    const t=b.dataset.cancelDeleteTag; pendingTagDelete = ''; renderTagManager();
    document.querySelector(`[data-delete-tag="${CSS.escape(t)}"]`)?.focus(); return;
  }
  if (b.dataset.confirmDeleteTag) {
    const t=b.dataset.confirmDeleteTag;setManagerDeleteBusy(b,true);
    const deleted=await commitCommand({type:'delete-tag',label:t},'',{render:false});
    if(deleted){managerDeleteErrors.delete(managerNameKey('tag',t));pendingTagDelete='';if(workspace==='collection')render();}
    else managerDeleteErrors.set(managerNameKey('tag',t),'删除失败，可重试');
    renderTagManager();setManagerDeleteBusy(b,false);
    return;
  }
  if (b.id === 'addSeries') {
    const raw=$('newSeriesName').value,label=cleanSeriesLabel(raw); if(!label)return toast('请输入系列名称。');
    const key=normalizeText(label), prefs=uiPreferences();
    if(prefs.series.some(x=>normalizeText(x.label)===key))return toast('系列名称已存在。');
    if(prefs.series.length>=MAX_SERIES)return toast(`最多管理 ${MAX_SERIES} 个系列。`);
    b.disabled=true;
    const ok=await commitCommand({type:'create-series',id:`series-${crypto.randomUUID()}`,label},'',{render:false});
    b.disabled=false;
    if(ok){ if($('newSeriesName').value===raw)$('newSeriesName').value=''; renderSeriesManager(); }
    return;
  }
  if (b.dataset.deleteSeries) {
    const prefs=uiPreferences(), target=prefs.series.find(x=>x.id===b.dataset.deleteSeries); if(!target)return;
    pendingSeriesDelete = pendingSeriesDelete === target.id ? '' : target.id;
    pendingListDelete = ''; pendingTagDelete = ''; renderSeriesManager();
    (pendingSeriesDelete ? document.querySelector(`[data-confirm-delete-series="${CSS.escape(target.id)}"]`) : document.querySelector(`[data-delete-series="${CSS.escape(target.id)}"]`))?.focus(); return;
  }
  if (b.dataset.cancelDeleteSeries) {
    const id=b.dataset.cancelDeleteSeries; pendingSeriesDelete = ''; renderSeriesManager();
    document.querySelector(`[data-delete-series="${CSS.escape(id)}"]`)?.focus(); return;
  }
  if (b.dataset.confirmDeleteSeries) {
    const id=b.dataset.confirmDeleteSeries,target=uiPreferences().series.find(x=>x.id===id);if(!target)return;
    setManagerDeleteBusy(b,true);
    const deleted=await commitCommand({type:'delete-series',id,expectedLabel:target.label},'',{render:false});
    if(deleted){
      managerDeleteErrors.delete(managerNameKey('series',id));pendingSeriesDelete='';
      const name=managerNames.get(managerNameKey('series',id));if(name)name.removed=true;managerNames.delete(managerNameKey('series',id));
      const activeDeleted=seriesFilter===id;if(activeDeleted){seriesFilter='';seriesFilterText='';}if(activeDeleted&&workspace==='collection')render();
    }else managerDeleteErrors.set(managerNameKey('series',id),'删除失败，可重试');
    renderSeriesManager();setManagerDeleteBusy(b,false);return;
  }
  if (b.dataset.seriesView) {
    const id = b.dataset.seriesView;
    const prefs = uiPreferences();
    if (!prefs.series.some(x => x.id === id)) return;
    const root = prefs.lists.find(x => x.kind === 'all');
    seriesFilter = id; seriesFilterText = ''; tag = ''; archiveYear = null; archiveSeason = ''; filterType = 'all'; page = 1; view = root?.id || 'library';
    await hideDialog('dataDialog'); openWorkspace('collection'); return;
  }
  if (b.dataset.progressAdd) {
    const item = library.entries.find(x => x.id === b.dataset.progressAdd);
    if (!item || item.status !== 'watching' || !item.total || item.progress >= item.total) return;
    const focusAnchor=collectionFocusAnchor(),interactionVersion=collectionInteractionVersion;
    b.disabled = true;
    try{if(await commitCommand({type:'increment-progress',id:item.id})&&current?.id===item.id)await openDetail(library.entries.find(entry=>entry.id===item.id),false);}
    finally{
      if(b.isConnected)b.disabled=false;
      if(document.activeElement===document.body&&collectionInteractionVersion===interactionVersion)restoreCollectionFocus(focusAnchor);
    }
    return;
  }
  if (b.dataset.open) { const item=library.entries.find(x=>x.id===b.dataset.open); if(item) openDetail(item); }
  if (b.dataset.view) { page=1; view=b.dataset.view; tag=''; archiveYear=null; archiveSeason=''; seriesFilter=''; seriesFilterText=''; document.body.classList.remove('menu-open'); syncNav(); openWorkspace('collection'); }
  if (b.dataset.close) hideDialog(b.dataset.close);
  if (b.dataset.query) { $('searchInput').value=b.dataset.query; await remoteSearch(); }
  if (b.hasAttribute('data-result')) openDetail(results[Number(b.dataset.result)]);
  if (b.hasAttribute('data-manual')) { await openManualFromSearch(searchQuery); }
  if ((b.dataset.status || b.dataset.rating) && current) {
    const id = current.id, status = b.dataset.status, rating = b.dataset.rating;
    const recovery=rating?{rating:Number(rating)}:{status,...(status==='completed'&&current.total?{progress:current.total}:{})};
    await updateSavedEntry(id, latest => {
      const next = {...latest};
      if (status) { next.status=status; if(status==='completed' && next.total) next.progress=next.total; }
      if (rating) next.rating=Number(rating);
      return next;
    },'',{recovery,recoveryAction:rating?'rating':'status'});
    if(current?.id===id) await openDetail(library.entries.find(item=>item.id===id),false);
  }
});
document.addEventListener('pointerdown', e => {
  const handle = e.target.closest?.('[data-list-drag]');
  if (!handle || handle.draggable === false || handle.closest('[data-list-row]')?.dataset.listKind === 'all') return;
  pointerListDrag = { pointerId:e.pointerId, sourceId:handle.dataset.listDrag, moved:false, target:null, before:false };
  handle.focus();
  try { handle.setPointerCapture?.(e.pointerId); } catch {}
  e.preventDefault();
});
document.addEventListener('pointermove', e => {
  const state = pointerListDrag;
  if (!state || state.pointerId !== e.pointerId) return;
  const row = document.elementFromPoint(e.clientX,e.clientY)?.closest?.('[data-list-row]');
  if (!row || row.dataset.listKind === 'all' || row.dataset.listRow === state.sourceId) return;
  state.moved = true; state.target = row; state.before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  document.querySelector(`[data-list-row="${CSS.escape(state.sourceId)}"]`)?.classList.add('is-dragging');
  document.querySelectorAll('.list-row.drop-before,.list-row.drop-after').forEach(x => x.classList.remove('drop-before','drop-after'));
  row.classList.add(state.before ? 'drop-before' : 'drop-after');
  e.preventDefault();
});
document.addEventListener('pointerup', async e => {
  const state = pointerListDrag;
  if (!state || state.pointerId !== e.pointerId) return;
  pointerListDrag = null;
  if (state.moved && state.target?.isConnected) await moveList(state.sourceId,state.target,state.before);
  else clearListDragState();
});
document.addEventListener('pointercancel', () => { pointerListDrag = null; clearListDragState(); });
document.addEventListener('change', e => {
  const input = e.target;
  if (input.dataset.detailList && current) {
    const prefs = uiPreferences();
    const selectedList = prefs.lists.find(list => list.id === input.dataset.detailList);
    // Keep the four legacy status buckets mutually exclusive while presenting
    // them as ordinary lists.  A record always has one internal status for
    // backwards-compatible filters, so changing the visible list chip should
    // never leave the navigation and drawer out of sync.
    if (selectedList?.kind === 'status') {
      if (input.checked) {
        document.querySelectorAll('[data-detail-list][data-detail-kind="status"]').forEach(other => { if (other !== input) other.checked = false; });
      } else if (!document.querySelector('[data-detail-list][data-detail-kind="status"]:checked')) {
        const fallback = prefs.lists.find(list => list.kind === 'status' && list.status === current.status) || prefs.lists.find(list => list.kind === 'status');
        const fallbackInput = fallback && document.querySelector(`[data-detail-list="${CSS.escape(fallback.id)}"]`);
        if (fallbackInput) fallbackInput.checked = true;
      }
    }
    const saved = library.entries.find(x => x.id === current.id || (current.sourceId && x.sourceId === current.sourceId));
    const listIds = [...document.querySelectorAll('[data-detail-list]:checked')].map(x => x.dataset.detailList);
    const next = detailListSelection(saved || current, listIds);
    if (!saved) { current = next; return; }
    void updateSavedEntry(saved.id, latest => detailListSelection(latest,listIds,true), '', {render:false,recoveryAction:'lists',recovery:{status:next.status,lists:next.lists,...(next.progress!==saved.progress?{progress:next.progress}:{})}}).then(() => {
      if (current?.id !== saved.id) return;
      renderNav();
      if (workspace === 'collection') render();
      void openDetail(library.entries.find(item=>item.id===saved.id),false);
    });
    return;
  }
  if (input.dataset.sourceToggle) {
    const sourceEnabled = { ...uiPreferences().sourceEnabled, [input.dataset.sourceToggle]: input.checked };
    input.closest('article')?.classList.toggle('is-disabled', !input.checked);
    savePreferences({sourceEnabled});
    return;
  }
  if(input.id==='timelineField'){timelineField=input.value;savePreferences({timeline:timelineField});renderTimeline();}
  if (input.matches?.('[data-select]')) {
    if (input.checked) selectedIds.add(input.dataset.select); else selectedIds.delete(input.dataset.select);
    input.closest('.poster-card')?.classList.toggle('selected', input.checked);
    renderBatchToolbar();
  }
  if(input.matches?.('[data-list-label],[data-series-label]')){
    const kind=input.dataset.listLabel?'list':'series',record=managerNameSaver(kind,input.dataset[`${kind}Label`]);
    if(!record.composing)void record.save.flush();
  }
  if (input.id === 'batchListSelect') renderBatchToolbar();
  if (input.dataset.catalogFilter) { catalogFilters[input.dataset.catalogFilter] = input.value; renderCatalog(); }
  if (input.id === 'progressRange' && current) {
    setProgress(current.id, input.value);
  }
});
document.addEventListener('input',e=>{if(e.target.matches?.('[data-list-label],[data-series-label]'))queueManagerName(e.target);});
document.addEventListener('compositionstart',e=>{
  const input=e.target;if(!input.matches?.('[data-list-label],[data-series-label]'))return;
  const kind=input.dataset.listLabel?'list':'series';managerNameSaver(kind,input.dataset[`${kind}Label`]).composing=true;
});
document.addEventListener('compositionend',e=>{
  const input=e.target;if(!input.matches?.('[data-list-label],[data-series-label]'))return;
  const kind=input.dataset.listLabel?'list':'series',record=managerNameSaver(kind,input.dataset[`${kind}Label`]);record.composing=false;queueManagerName(input);
  if(record.redraw){record.redraw=false;if(kind==='list')renderListManager();else renderSeriesManager();}
});
$('addWork').onclick = () => openForm();
$('emptySearch').onclick = openSearch;
$('emptyManual').onclick = () => openForm();
$('emptyImport').onclick = () => { settingsTab='data'; loadSettings(); showDialog('dataDialog'); };
$('emptyClearFilters').onclick = () => $('resetFilters').click();

$('quickAdd').onclick = () => searchQuery ? openManualFromSearch(searchQuery) : openForm(); $('closeDrawer').onclick=closeDetail; $('detailBackdrop').onclick=closeDetail;
$('clearSearch').onclick=()=>{ $('searchInput').value=''; $('searchInput').dispatchEvent(new Event('input',{bubbles:true})); $('searchInput').focus(); };
$('sortSelect').onchange=()=> {page=1;savePreferences({sort:$('sortSelect').value});};
$('filterType').onchange=()=>{page=1;filterType=$('filterType').value;render();};
$('filterYear').onchange=()=>{page=1;archiveYear=Number($('filterYear').value)||null;render();};
$('filterSeason').onchange=()=>{page=1;archiveSeason=$('filterSeason').value;render();};
$('filterTag').oninput=()=>{page=1;tag=$('filterTag').value.trim().slice(0,40);render();};
$('resetFilters').onclick=()=>{page=1;filterType='all';archiveYear=null;archiveSeason='';seriesFilter='';seriesFilterText='';tag='';$('filters').open=false;render();};
$('filterSeries').oninput=()=>{page=1;const value=$('filterSeries').value.trim().slice(0,40), series=uiPreferences().series, match=series.find(item=>normalizeText(item.label)===normalizeText(value));seriesFilter=match?.id || '';seriesFilterText=value;render();};
const narrowScreen=matchMedia('(max-width:920px)');
function syncNav() { document.querySelector('.sidebar').inert=narrowScreen.matches&&!document.body.classList.contains('menu-open');$('mobileMenu').setAttribute('aria-expanded',document.body.classList.contains('menu-open'));syncNoticeLocation(); }
$('mobileMenu').onclick=()=>{document.body.classList.toggle('menu-open');syncNav();};
narrowScreen.addEventListener('change',syncNav);syncNav();
document.addEventListener('click',e=>{if(document.body.classList.contains('menu-open')&&!e.target.closest('.sidebar, #mobileMenu')){document.body.classList.remove('menu-open');syncNav();}});
 $('searchInput').addEventListener('input',()=> {
  clearTimeout(searchTimer);
  const value = $('searchInput').value.trim();
  searchWaiting = value.length >= 2;
  runSearch();
  if (searchWaiting) { renderSearch(); searchTimer=setTimeout(()=>remoteSearch(),2200); }
 });
$('openSettings').onclick=()=>{
  loadSettings(); showDialog('dataDialog');
};
$('openDataFolder').onclick=openDataFolder;
$('refreshSources').onclick=()=>health('all');
$('refreshBackups').onclick=()=>{backupFeedback='';loadLocalBackups();};
$('createSnapshot').onclick=()=>createLocalSnapshot();
$('exportCovers').onclick=()=>exportCovers().catch(e=>$('coverTransferState').textContent=`导出失败：${e.message}`);
$('pruneCovers').onclick=()=>pruneCovers();
$('importCovers').onchange=e=>importCovers(e.target.files[0]);
$('runDataAudit').onclick=runDataAudit;
$('tagSearch').oninput=()=>{tagSearch=$('tagSearch').value.trim();renderTagManager();};
$('newTagName').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();$('addTag').click();}});
$('seriesSearch').oninput=()=>{seriesSearch=$('seriesSearch').value.trim();renderSeriesManager();};
$('newSeriesName').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();$('addSeries').click();}});
$('entrySeriesQuery').addEventListener('focus',()=>{seriesPickerIndex=0;renderEntrySeriesSuggestions();});
$('entrySeriesQuery').addEventListener('input',()=>{seriesPickerIndex=0;renderEntrySeriesSuggestions();});
$('entrySeriesQuery').addEventListener('keydown',e=>{
  if(e.isComposing)return;
  const options=entrySeriesOptions();
  if(['ArrowDown','ArrowUp'].includes(e.key)&&options.length){e.preventDefault();seriesPickerIndex=(seriesPickerIndex+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;renderEntrySeriesSuggestions();return;}
  if(e.key==='Enter'&&options.length){e.preventDefault();setEntrySeries(options[seriesPickerIndex]?.id || options[0].id,true);return;}
  if(e.key==='Escape'&&!$('entrySeriesSuggestions').hidden){e.preventDefault();e.stopPropagation();setEntrySeries($('entrySeries').value);}
});
$('entrySeriesQuery').addEventListener('blur',()=>setTimeout(()=>{
  if(!$('entrySeriesQuery').closest('.series-picker')?.contains(document.activeElement))setEntrySeries($('entrySeries').value);
},0));
$('clearEntrySeries').onclick=()=>{setEntrySeries('',true);$('entrySeriesQuery').focus();};
$('entryTagInput').addEventListener('input', renderEntryTagSuggestions);
$('entryTagInput').addEventListener('focus', renderEntryTagSuggestions);
$('entryTagInput').addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault(); addEntryTag(e.currentTarget.value);
  }
  if (e.key === 'Backspace' && !e.currentTarget.value) {
    const values = entryTagValues(); if (values.length) { e.preventDefault(); renderEntryTagPicker(values.slice(0, -1)); queueEntryEdit(); }
  }
});
function saveGeneralSettings(changedId = '') {
  page=1;
  if (changedId === 'themeSelect') { savePreferences({theme:$('themeSelect').value}); return; }
  if (changedId === 'modeSelect') { syncModeToggle(); savePreferences({mode:$('modeSelect').value}); return; }
  const timeValue = $('timeDisplay').value;
  savePreferences({ columns:Number($('layoutColumns').value), rows:Number($('layoutRows').value),
    theme:$('themeSelect').value, mode:$('modeSelect').value, time:timeValue === 'hidden' ? 'none' : timeValue,
    display:{...uiPreferences().display,year:timeValue !== 'hidden',type:$('showType').checked,rating:$('showRating').checked,count:$('showCount').checked} });
}
$('settingsGeneral').addEventListener('change', e => {
  if (e.target.id === 'accentColor') return;
  if (e.target.matches('input, select')) saveGeneralSettings(e.target.id);
  if (e.target.matches('select.choice-native')) syncChoiceGroup(e.target.id);
});
$('accentColor').addEventListener('input', () => savePreferences({accent:$('accentColor').value}));
$('resetAccent').onclick=()=>{savePreferences({accent:''});loadGeneralSettings();};
$('modeToggle').onclick=()=>{
  const select = $('modeSelect');
  select.value = select.value === 'dark' ? 'light' : 'dark';
  syncModeToggle();
  savePreferences({mode:select.value});
};
$('retrySettings').onclick=()=>settingsSave.flush();
$('retrySourceSettings').onclick=()=>settingsSave.flush();
$('previousPage').onclick=()=>{page--;render();$('collectionSection').scrollIntoView({block:'start'});};
$('nextPage').onclick=()=>{page++;render();$('collectionSection').scrollIntoView({block:'start'});};
$('loadMoreEntries').onclick=()=>{continuousShown+=120;render();};
let gridWidth=0, resizeTimer;
new ResizeObserver(records=>{
  const width=Math.round(records[0].contentRect.width);
  if(width!==gridWidth){gridWidth=width;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(loaded)render();},100);}
}).observe($('posterGrid'));
$('checkCover').onclick=async()=>{
  const url=customImageUrl($('customCoverInput').value), version=++coverVersion;
  if(!url){$('coverFeedback').textContent='请输入公开网站的 HTTPS 图片直链。';return;}
  $('checkCover').disabled=true; $('coverFeedback').textContent='检测中…';
  try{
    await api('/api/cover-check',{method:'POST',body:JSON.stringify({url})});
    if(version===coverVersion)$('coverFeedback').textContent='图片可用';
  }catch(e){if(version===coverVersion)$('coverFeedback').textContent='图片暂不可用：'+e.message+'。可更换链接，或保存后稍后重试。';}
  finally{$('checkCover').disabled=false;}
};
$('customCoverInput').oninput=()=>{coverVersion++;$('coverFeedback').textContent='';};
$('resetCover').onclick=()=>{coverVersion++;$('customCoverInput').value='';$('coverFeedback').textContent='';queueEntryEdit();};
$('exportTransfer').onclick=()=>exportTransfer().catch(e=>toast(e.message));
$('exportData').onclick=()=>exportBackup().catch(e=>toast(e.message));
$('importData').onchange=e=>readBackup(e.target.files[0]);
$('cancelImport').onclick=clearImportReview;
$('importMode').onchange=importPreview;
$('importConfirm').onclick=confirmImport;
    $('drawerContent').addEventListener('input',e=>{
      if(e.target.id==='noteInput' && current) {
        dirty=true;
        if(noteComposing){queueNoteEdit(e.target.value,false);setNoteStatus('pending');}
        else queueNoteEdit(e.target.value);
      }
      if(e.target.id==='progressRange') {
        const value=Number(e.target.value)||0, max=Number(e.target.max)||0;
        const fill=e.target.closest('.track')?.querySelector('i'); if(fill) fill.style.width=`${max ? value/max*100 : 0}%`;
        const label=$('progressLabel'); if(label) label.textContent=`${value} / ${max} ${unitText(current)}${max ? '' : ` · 总${unitText(current)}数未知，可手动补充`}`;
      }
    });
$('drawerContent').addEventListener('compositionstart',e=>{
  if(e.target.id==='noteInput')noteComposing=true;
});
$('drawerContent').addEventListener('compositionend',e=>{
  if(e.target.id!=='noteInput'||!current)return;
  noteComposing=false;dirty=true;queueNoteEdit(e.target.value);
  if(detailRedrawPending){detailRedrawPending=false;void openDetail(library.entries.find(item=>item.id===current.id)||current,false);}
});
$('drawerContent').addEventListener('click',async e=> {
  const b=e.target.closest('button'); if(!b || !current)return;
  if(b.id==='retryNote') { await noteSave.flush(); return; }
  if(b.id==='editEntry') openForm(current);
  if(b.id==='restartEntry') {
    const targetId=current.id;let original;
    if(await commitCommand({type:'restart-entry',id:targetId},'',{onApplied:effects=>{original=effects.previous;}}) && current?.id===targetId) {
      openDetail(library.entries.find(item=>item.id===original.id),false);
      toast('已从头开始观看。',{label:'撤销',run:async()=>{
        await commitCommand({type:'undo-restart',id:original.id,previous:{status:original.status,progress:original.progress}},'',{throwOnError:true});
        if(current?.id===original.id)await openDetail(library.entries.find(item=>item.id===original.id),false);
      }});
    }
    return;
  }
  if(b.id==='editRemote') { openForm(current); return; }
  if(b.id==='addEntry') {
    await addDetailEntry();
  }
  if(b.id==='removeEntry') {
    const targetId=current.id;let removed;
    if(dirty) {toast('笔记保存中，请稍后重试。');return;}
    if(await commitCommand({type:'remove-entry',id:targetId},'',{onApplied:effects=>{removed=effects.removed;}})) {
      if(current?.id===targetId)await closeDetail();
      toast('已移出收藏；自动备份仍保留最近版本。',{label:'撤销',run:()=>commitCommand({type:'restore-entry',entry:removed},'已恢复',{throwOnError:true})});
    }
  }
  if(b.id==='refreshMetadata') {
    b.disabled=true; b.textContent='正在获取…'; const target=current;
    try {
      const remote=await api(`/api/catalog/detail?id=${encodeURIComponent(target.sourceId)}`);
      const existing=library.entries.find(x=>x.id===target.id); if(!existing)return;
      // Keep the user's title, progress, tags, notes, aliases and status. Only refresh source metadata.
      if(await updateSavedEntry(target.id,latest=>({...latest,cover:remote.cover || latest.cover,description:remote.description || latest.description,score:remote.score, statusText:remote.statusText, fetchedAt:remote.fetchedAt,
        airedAt:remote.airedAt || latest.airedAt, studios:remote.studios?.length ? remote.studios : latest.studios,
        broadcastDay:remote.broadcastDay || latest.broadcastDay, broadcastTime:remote.broadcastTime || latest.broadcastTime, broadcastTimezone:remote.broadcastTimezone || latest.broadcastTimezone,
        total:remote.total && remote.total>=latest.progress ? remote.total : latest.total, year:latest.year || remote.year, season:latest.season || remote.season,
        aliases:[...new Set([...latest.aliases,...remote.aliases])].slice(0,24)}),'资料已刷新，个人记录已保留') && current?.id===target.id) openDetail(library.entries.find(item=>item.id===target.id),false);
    }catch(err){toast(`刷新失败：${err.message}。现有资料仍可使用。`);}finally{b.disabled=false;b.textContent='刷新资料';}
  }
});
function syncEntryFormLists(changed = null) {
  const root = $('listMembership'), status = $('entryStatus');
  if (!root || !status) return;
  const inputs = [...root.querySelectorAll('input[name="lists"]')];
  const statusInputs = inputs.filter(input => input.dataset.entryListKind === 'status');
  if (changed?.dataset.entryListKind === 'status' && changed.checked) {
    statusInputs.forEach(input => { if (input !== changed) input.checked = false; });
  }
  let active = statusInputs.find(input => input.checked);
  if (!active && statusInputs.length) {
    active = statusInputs.find(input => input.dataset.entryListStatus === status.value) || statusInputs[0];
    active.checked = true;
  }
  if (active) {
    status.value = active.dataset.entryListStatus || 'planned';
  }
}
function captureEntryDraft() {
  syncEntryFormLists();
  const form=new FormData($('entryForm'));
  const listDefs = new Map(uiPreferences().lists.map(list => [list.id, list]));
  const lists = form.getAll('lists').filter(id => listDefs.get(id)?.kind === 'custom');
  return {id:editId,version:formVersion,valid:$('entryForm').checkValidity(),values:Object.fromEntries(form),lists,changedFields:[...entryChangedFields]};
}
function recoveryFormDraft(){
  const {values,lists}=captureEntryDraft();return {kind:'form',values,lists,seed:entrySeed,enrichQuery:manualEnrichQuery,baseline:entryBaseline};
}
function rememberRecovery(record){
  recoveryById.set(record.id,record);recoveryRecords=[...recoveryRecords.filter(item=>item.id!==record.id),record];renderEntryRecovery();return record;
}
function renderEntryRecovery(){
  const unavailable=recoveryLoading||Boolean(recoveryError)||recoveryDeleting;
  $('entryRecovery').hidden=!recoveryRecords.length&&!editRecoverableRecords.length&&!recoveryError&&!editRecoveryError&&$('editRecoveryRepair').hidden&&!storageRecoveryInline;
  $('entryRecovery').setAttribute('aria-busy',String(recoveryLoading));
  $('refreshEntryRecovery').disabled=recoveryLoading||recoveryDeleting;
  $('entryRecoveryState').textContent=recoveryLoading?'正在读取未完成记录…':recoveryError||editRecoveryError||'未完成的输入保留在本机，可继续处理。';
  $('entryRecoveryState').dataset.state=!recoveryLoading&&(recoveryError||editRecoveryError)?'error':'';
  $('repairEditRecovery').hidden=!editRecoveryError;
  $('repairEntryDraftRecords').hidden=!recoveryError;
  $('entryRecoveryMenu').hidden=!recoveryRecords.length&&!editRecoverableRecords.length;
  $('entryRecoverySummary').textContent=`继续未完成 · ${recoveryRecords.length+editRecoverableRecords.length}`;
  $('entryRecoveryItems').innerHTML=[...recoveryRecords].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(item=>{
    const title=item.draft.values?.title || item.draft.seed?.title || '未命名作品',confirming=recoveryDiscard?.id===item.id;
    return `<div class="entry-recovery-row" role="group" aria-label="${esc(title)}"><button type="button" class="text-btn" data-resume-entry="${esc(item.id)}" ${unavailable?'disabled':''}><span>${esc(title)}</span><small>${item.intent?'待确认添加':'录入草稿'}</small></button>${item.intent?'':confirming?`<div class="entry-recovery-confirm" aria-label="放弃未提交的草稿"><span>放弃这份草稿？</span><button type="button" class="text-btn" data-keep-entry-draft ${recoveryDeleting?'disabled':''}>继续保留</button><button type="button" class="text-btn danger" data-discard-entry-draft ${unavailable?'disabled':''}>放弃草稿</button></div>`:`<button type="button" class="text-btn" data-ask-discard-entry-draft="${esc(item.id)}" aria-label="放弃 ${esc(title)} 的草稿" ${unavailable?'disabled':''}>放弃</button>`}${confirming&&(recoveryDeleting||recoveryDeleteError)?`<p class="entry-recovery-feedback" role="status" tabindex="-1">${esc(recoveryDeleting?'正在放弃草稿…':recoveryDeleteError)}</p>`:''}</div>`;
  }).join('')+editRecoverableRecords.map(item=>`<div class="entry-recovery-row edit-recovery-row" role="group" aria-label="${esc(item.label)}"><button type="button" class="text-btn" data-resume-edit="${esc(item.id)}" ${saveCoordinator.unconfirmed?'disabled':''}><span>${esc(item.label)}</span><small>${item.kind==='command'?'待完成操作':({note:'笔记',form:'作品编辑',settings:'设置',manager:'名称',fields:'进度／评分／列表'})[item.kind]+'草稿'}</small></button>${editDiscardId===item.id?`<div class="entry-recovery-confirm"><span>放弃这份编辑？</span><button type="button" class="text-btn" data-keep-edit>继续保留</button><button type="button" class="text-btn danger" data-discard-edit="${esc(item.id)}">放弃</button></div>`:`<button type="button" class="text-btn" data-export-edit="${esc(item.id)}" aria-label="导出 ${esc(item.label)} 的草稿">导出</button><button type="button" class="text-btn" data-ask-discard-edit="${esc(item.id)}" aria-label="放弃 ${esc(item.label)} 的编辑">放弃</button>`}</div>`).join('');
}
async function loadEntryRecovery(){
  const version=++recoveryVersion,read=++recoveryReadSequence,refreshFocused=document.activeElement===$('refreshEntryRecovery');
  recoveryLoading=true;renderEntryRecovery();
  try{const result=await api('/api/entry-drafts');if(version!==recoveryVersion)return false;recoveryRecords=result.drafts;recoveryById.clear();for(const record of recoveryRecords)recoveryById.set(record.id,record);if(recoveryDiscard&&recoveryRecords.find(item=>item.id===recoveryDiscard.id)?.version!==recoveryDiscard.version){recoveryDiscard=null;recoveryDeleteError='';}recoveryError='';if(entryDraftRecoveryNotice){notices.remove(entryDraftRecoveryNotice);entryDraftRecoveryNotice=null;}return true;}
  catch(error){if(version!==recoveryVersion)return false;recoveryError=`未能读取添加草稿：${errorMessage(error).replace(/[。.!！]+$/u,'')}。请重新读取后继续。`;return false;}
  finally{if(read===recoveryReadSequence){recoveryLoading=false;renderEntryRecovery();if(refreshFocused&&document.activeElement===document.body&&!activeDialog&&!current)$('refreshEntryRecovery').focus({preventScroll:true});}}
}
async function allocateRecoveryRecord(record){
  if(record.version||record.id.includes(':'))return record;
  if(!recoveryAllocations.has(record.id)){
    const promise=api('/api/entry-drafts/allocate',{method:'POST'});
    recoveryAllocations.set(record.id,promise);
    promise.catch(()=>{if(recoveryAllocations.get(record.id)===promise)recoveryAllocations.delete(record.id);});
  }
  const allocation=recoveryAllocations.get(record.id),allocated=await allocation;
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if(typeof allocated?.id!=='string'||allocated.id.length!==73||allocated.id[36]!==':'||!uuid.test(allocated.id.slice(0,36))||!uuid.test(allocated.id.slice(37))||allocated.version!==0){
    if(recoveryAllocations.get(record.id)===allocation)recoveryAllocations.delete(record.id);
    throw Error('草稿准备响应无法核对，请重试。');
  }
  recoveryAllocationOrigins.set(allocated.id,record.id);
  if(formDraftRecord?.id===record.id&&!formDraftRecord.version)formDraftRecord=allocated;
  if(!draftWriteVersions.has(allocated.id))draftWriteVersions.set(allocated.id,0);
  return allocated;
}
async function saveRecoveryDraft(id,draft,intent=null){
  ++recoveryVersion;
  ({id}=await allocateRecoveryRecord({id,version:draftWriteVersions.get(id)||0}));
  lastSentDrafts.set(id,draft);
  const record=await api('/api/entry-drafts',{method:'PUT',body:JSON.stringify({id,version:draftWriteVersions.get(id) || 0,draft,intent})});
  draftWriteVersions.set(id,record.version);
  return rememberRecovery(record);
}
async function forgetRecovery(record,requestId,draft){
  if(!record.version&&!record.id.includes(':')){
    if(!recoveryAllocations.has(record.id)){draftWriteVersions.delete(record.id);lastSentDrafts.delete(record.id);return;}
    record=await allocateRecoveryRecord(record);
  }
  ++recoveryVersion;await api('/api/entry-drafts/delete',{method:'POST',body:JSON.stringify({id:record.id,version:record.version,requestId,draft})});
  recoveryRecords=recoveryRecords.filter(item=>item.id!==record.id);recoveryById.delete(record.id);renderEntryRecovery();
  clearRecoveryTracking(record.id);
}
function clearRecoveryTracking(id){
  draftWriteVersions.delete(id);lastSentDrafts.delete(id);
  const local=recoveryAllocationOrigins.get(id);if(local){recoveryAllocations.delete(local);recoveryAllocationOrigins.delete(id);draftWriteVersions.delete(local);lastSentDrafts.delete(local);}
}
async function discardFormDraft(){
  if(!formDraftRecord)return true;
  try{await forgetRecovery(formDraftRecord,undefined,lastSentDrafts.get(formDraftRecord.id));formDraftRecord=null;return true;}
  catch(error){
    if(error.status===409){formDraftRecord=null;toast('本窗口的修改已放弃，其他窗口的草稿或添加操作仍保留。');void loadEntryRecovery();return true;}
    entryAddNotice(`未丢弃草稿：${errorMessage(error)}。内容仍保留。`);return false;
  }
}
async function resumeEntryDraft(id){
  if(!await loadEntryRecovery())return false;const record=recoveryRecords.find(item=>item.id===id);if(!record)return false;
  if(record.intent){
    let status;try{status=await api(`/api/entries/add-status?id=${record.intent.requestId}`);}catch{/* Open the frozen draft when confirmation is unavailable. */}
    if(status?.state==='completed'){
      library=status.library;render();try{await forgetRecovery(record,record.intent.requestId);}catch(error){toast(`作品已添加，草稿清理未完成：${errorMessage(error)}`);}
      const saved=library.entries.find(item=>item.id===record.intent.entry.id);if(saved)await openDetail(saved);else toast('这次添加已完成，作品目前已不在收藏中。未重新添加。');return true;
    }
  }
  if(record.draft.kind==='form')return openForm(record.draft.seed,false,record);
  await openDetail(record.intent?.entry || record.draft.seed);
  if(current?.id!==record.draft.seed.id)return false;
  detailAddAttempt={next:record.intent?.entry || record.draft.seed,payload:record.intent?{...record.intent,draftId:record.id}:null,record,draft:record.draft,pending:Boolean(record.intent),prepared:Boolean(record.intent)};
  draftWriteVersions.set(record.id,record.version);
  const destination=detailAddAttempt.next;
  document.querySelectorAll('[data-detail-list]').forEach(control=>{control.checked=control.dataset.detailKind==='status'?control.dataset.detailStatus===destination.status:destination.lists.includes(control.dataset.detailList);});
  syncDetailAddLock();if($('detailAddState')){$('detailAddState').hidden=false;$('detailAddState').textContent='已恢复未完成的收录，可继续核对同一次操作。';$('detailAddState').dataset.state='error';}
  return true;
}
$('refreshEntryRecovery').onclick=async()=>{try{const records=await editRecovery.read();editRecoverableRecords=records.filter(item=>item.kind!=='intent'&&!([...editDrafts.values()].some(owned=>owned.id===item.id)));editRecoveryError='';}catch(error){editRecoveryError=errorMessage(error);}await loadEntryRecovery();};
$('entryRecoveryItems').onclick=async event=>{
  const button=event.target.closest('button');if(!button||button.disabled||recoveryDeleting)return;
  if(button.dataset.resumeEdit){try{await resumeEditDraft(button.dataset.resumeEdit);}catch(error){toast(errorMessage(error));}return;}
  if(button.dataset.exportEdit){const record=editRecoverableRecords.find(item=>item.id===button.dataset.exportEdit);if(record)downloadJson(record,`番渡编辑草稿-${record.kind}-${new Date().toISOString().slice(0,10)}.json`);return;}
  if(button.dataset.askDiscardEdit){editDiscardId=button.dataset.askDiscardEdit;renderEntryRecovery();$('entryRecoveryItems').querySelector('[data-keep-edit]')?.focus();return;}
  if(button.hasAttribute('data-keep-edit')){editDiscardId='';renderEntryRecovery();$('entryRecoverySummary').focus();return;}
  if(button.dataset.discardEdit){
    const record=editRecoverableRecords.find(item=>item.id===button.dataset.discardEdit);if(!record)return;
    button.disabled=true;
    try{if(!await editRecovery.forgetDraft(record.id,record.version))throw Error('草稿已变化，请重新读取后决定');editRecoverableRecords=editRecoverableRecords.filter(item=>item.id!==record.id);editDiscardId='';renderEntryRecovery();($('entryRecovery').hidden?$('addWork').hidden?$('emptyManual'):$('addWork'):$('entryRecoverySummary')).focus();}
    catch(error){toast(errorMessage(error));button.disabled=false;}return;
  }
  if(button.dataset.resumeEntry){if(await resumeEntryDraft(button.dataset.resumeEntry))$('entryRecoveryMenu').open=false;return;}
  if(button.dataset.askDiscardEntryDraft){recoveryDiscard=recoveryRecords.find(item=>item.id===button.dataset.askDiscardEntryDraft);recoveryDeleteError='';renderEntryRecovery();$('entryRecoveryItems').querySelector('[data-keep-entry-draft]')?.focus();return;}
  if(button.hasAttribute('data-keep-entry-draft')){const id=recoveryDiscard?.id;recoveryDiscard=null;recoveryDeleteError='';renderEntryRecovery();$('entryRecoveryItems').querySelector(`[data-ask-discard-entry-draft="${CSS.escape(id || '')}"]`)?.focus();return;}
  if(button.hasAttribute('data-discard-entry-draft')&&recoveryDiscard){
    recoveryDeleting=true;renderEntryRecovery();$('entryRecoveryItems').querySelector('.entry-recovery-feedback')?.focus();
    try{await forgetRecovery(recoveryDiscard);recoveryDiscard=null;recoveryDeleteError='';}
    catch(error){recoveryDeleteError=`未放弃：${errorMessage(error)}。请重新读取后再核对。`;}
    finally{recoveryDeleting=false;renderEntryRecovery();(recoveryDiscard?$('entryRecoveryItems').querySelector('[data-keep-entry-draft]'):recoveryRecords.length?$('entryRecoverySummary'):!$('addWork').hidden?$('addWork'):$('emptyManual'))?.focus();}
  }
};
async function performAddition(attempt){
  const task=commitTail.then(async()=>{
    saving=true;syncBackupAvailability();
    try{
      try{attempt.record=await allocateRecoveryRecord(attempt.record);}catch(error){return {state:'rejected',error};}
      attempt.payload ||= {requestId:crypto.randomUUID(),revision:library.revision,entry:attempt.next,draftId:attempt.record.id};
      let outcome,preparationRejected=false;
      if(!attempt.prepared){
        try{attempt.record=await saveRecoveryDraft(attempt.record.id,attempt.draft,attempt.payload);attempt.prepared=true;}
        catch(error){
          await loadEntryRecovery();const record=recoveryById.get(attempt.record.id);
          if(record?.intent?.requestId===attempt.payload.requestId && JSON.stringify(record.intent.entry)===JSON.stringify(attempt.next)){
            try{attempt.record=await saveRecoveryDraft(attempt.record.id,attempt.draft,attempt.payload);attempt.prepared=true;}catch(confirmationError){error=confirmationError;}
          }
          if(!attempt.prepared){
            // A prior prepare may have succeeded and another window may have
            // finished it. Confirm first, even when this response is 4xx.
            outcome=await resolveAddition(attempt.payload,{send:async()=>{throw error;},confirm:id=>api(`/api/entries/add-status?id=${encodeURIComponent(id)}`)});
            if(outcome.state==='pending')return outcome;
            preparationRejected=outcome.state==='rejected';
          }
        }
      }
      outcome ||= await resolveAddition(attempt.payload,{send:payload=>api('/api/entries/add',{method:'POST',body:JSON.stringify(payload)}),confirm:id=>api(`/api/entries/add-status?id=${encodeURIComponent(id)}`)});
      if(outcome.state==='rejected'){
        try{
          const release=await api('/api/entry-drafts/release',{method:'POST',body:JSON.stringify({id:attempt.record.id,requestId:attempt.payload.requestId})});
          if(release.state==='completed')outcome=await resolveAddition(attempt.payload,{send:async()=>release,confirm:id=>api(`/api/entries/add-status?id=${id}`)});
          else if(release.state==='released'){
            if(release.record)rememberRecovery(release.record);
            else{recoveryRecords=recoveryRecords.filter(item=>item.id!==attempt.record.id);recoveryById.delete(attempt.record.id);renderEntryRecovery();}
            if(release.record&&!preparationRejected)attempt.record=release.record;
            else{clearRecoveryTracking(attempt.record.id);attempt.record={id:crypto.randomUUID(),version:0};}
            draftWriteVersions.set(attempt.record.id,attempt.record.version);
          }else throw Error('草稿状态无法核对');
        }catch(error){
          const read=preparationRejected&&error.status===409?await loadEntryRecovery():false,foreign=recoveryById.get(attempt.record.id);
          if(read&&foreign?.intent&&foreign.intent.requestId!==attempt.payload.requestId){clearRecoveryTracking(attempt.record.id);attempt.record={id:crypto.randomUUID(),version:0};draftWriteVersions.set(attempt.record.id,0);}
          else outcome={state:'pending',error};
        }
      }
      if(outcome.state==='completed'){
        library=outcome.result.library;render();
        try{await forgetRecovery(attempt.record,attempt.payload.requestId);}catch(error){toast(`作品已添加，草稿清理未完成：${errorMessage(error)}`);}
      }else if(outcome.state==='rejected'&&outcome.error?.status===409){
        // Only a definitively rejected operation can rebase a later retry.
        // Never change the revision of an unresolved, frozen intention.
        try{library=await api('/api/library');render();}catch{/* Keep the current inputs; the next conflict can retry this read. */}
      }
      return outcome;
    }finally{saving=false;syncBackupAvailability();}
  });
  commitTail=task.catch(()=>{});return task;
}
function syncDetailAddLock(){
  syncNoticeBlocking();
  if(!$('addEntry')){$('closeDrawer').disabled=false;return;}
  const locked=detailAdding||Boolean(detailAddAttempt?.pending);
  $('closeDrawer').disabled=detailAdding || Boolean(detailAddAttempt?.pending&&!detailAddAttempt.prepared);
  $('editRemote').disabled=locked;
  document.querySelectorAll('[data-detail-list]').forEach(control=>control.disabled=locked);
  $('detailDrawer').querySelector('.detail-lists')?.setAttribute('aria-busy',String(detailAdding));
  $('addEntry').disabled=detailAdding||saveCoordinator.unconfirmed;$('addEntry').textContent=detailAdding?'正在添加…':detailAddAttempt?.pending?'继续添加':'添加到列表';
}
async function addDetailEntry(){
  if(!current || detailAdding||saveCoordinator.unconfirmed)return;
  if(!detailAddAttempt || !detailAddAttempt.pending){
    const lists=[...document.querySelectorAll('[data-detail-list]:checked')].map(input=>input.dataset.detailList),now=new Date().toISOString();
    const next=entry({...detailListSelection(current,lists,false),createdAt:now,updatedAt:now});
    detailAddAttempt={next,record:detailAddAttempt?.record || {id:crypto.randomUUID(),version:0},draft:{kind:'detail',seed:next},payload:null,pending:false,prepared:false};
  }
  const attempt=detailAddAttempt;detailAdding=true;syncDetailAddLock();
  $('detailAddState').hidden=false;$('detailAddState').dataset.state='saving';$('detailAddState').textContent='正在添加作品…';$('detailAddState').focus();
  try{
    const outcome=await performAddition(attempt);
    if(outcome.state==='completed'){
      detailAdding=false;detailAddAttempt=null;syncDetailAddLock();const saved=library.entries.find(item=>item.id===attempt.next.id);
      if(saved){await openDetail(saved,false);$('editEntry')?.focus({preventScroll:true});}else{await closeDetail();toast('这次添加已完成，作品目前已不在收藏中。未重新添加。');}
    }else{
      attempt.pending=outcome.state==='pending';if(!attempt.pending){attempt.payload=null;attempt.prepared=false;}
      detailAdding=false;syncDetailAddLock();$('detailAddState').dataset.state='error';$('detailAddState').textContent=attempt.pending?'添加结果尚未确认。请继续同一次添加；内容已保留，未重复收录。':`未添加：${errorMessage(outcome.error)}`;$('addEntry').focus();
    }
  }catch(error){attempt.pending=true;detailAdding=false;syncDetailAddLock();$('detailAddState').dataset.state='error';$('detailAddState').textContent=`添加尚未确认：${errorMessage(error)}。请继续同一次添加。`;}
  finally{detailAdding=false;syncDetailAddLock();}
}
function queueEntryEdit() {
  if(entryAdding || entryAddAttempt?.pending || entryDiscardOpen)return;
  if(editId){
    const observed=captureEntryDraft();
    if(entryObservedDraft){
      for(const [key,value] of Object.entries(observed.values))if(key!=='lists'&&value!==entryObservedDraft.values[key])entryChangedFields.add(key);
      if(JSON.stringify(observed.lists)!==JSON.stringify(entryObservedDraft.lists))entryChangedFields.add('lists');
    }
    entryObservedDraft=observed;
  }
  const signature=entryDraftSignature();
  if(!editId&&!formComposing&&signature===lastQueuedDraftSignature)return;
  resetEntryAddNotice();
  formDirty=editId ? true : signature!==entryBaseline;formVersion++;
  if(editId){
    const draft=captureEntryDraft();draft.recoveryVersion=rememberEdit('form',editId,draft,draft.values.title||library.entries.find(item=>item.id===editId)?.title||'作品编辑');
    if(!formComposing)entrySave.schedule({draft});
  }
  else if(!editId&&!formComposing&&formDraftRecord){lastQueuedDraftSignature=signature;formDraftSave.schedule({id:formDraftRecord.id,draft:recoveryFormDraft()});}
}
function entryFromDraft(draft,previous) {
  const form={get:key=>draft.values[key],getAll:()=>draft.lists};
  const list=v=>String(v || '').split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  const total=form.get('total')?Number(form.get('total')):null, progress=Number(form.get('progress') || 0);
  if(total && progress>total)throw Object.assign(Error('已看集数不能大于总集数'),{field:'progress'});
  const coverInput=String(form.get('customCover') || '').trim();
  if(coverInput&&!customImageUrl(coverInput))throw Object.assign(Error('封面链接需为公开网站的 HTTPS 图片直链'),{field:'customCover'});
  const now=new Date().toISOString();
  const seed = previous || (!draft.id ? entrySeed : null) || {};
  const next=entry({...seed,id:draft.id || seed.id || crypto.randomUUID(),title:form.get('title'),type:form.get('type'),year:Number(form.get('year')) || null,season:form.get('season'),region:form.get('region'),
    total,progress:form.get('status')==='completed' && total ? total : progress,status:form.get('status'),tags:parseTags(form.get('tags')),aliases:list(form.get('aliases')),
    customCover:coverInput,lists:draft.lists || [],seriesId:form.get('seriesId'),originalTitle:form.get('originalTitle'),note:form.get('note'),description:form.get('description'),createdAt:previous?previous.createdAt:now,updatedAt:now});
  if(!previous||!Array.isArray(draft.changedFields))return next;
  // A form is a view of many fields, not an intent to rewrite every field.
  // Remember touched fields (including a revert to the initial value) so a
  // queued title edit cannot replace another window's newer note or progress.
  const merged={...previous,updatedAt:now};
  for(const key of draft.changedFields)if(Object.hasOwn(next,key))merged[key]=next[key];
  if(merged.status==='completed'&&merged.total&&draft.changedFields.some(key=>['status','total','progress'].includes(key)))merged.progress=merged.total;
  return entry(merged);
}
$('entryForm').addEventListener('input',e=>{if(e.target.id!=='entrySeriesQuery')queueEntryEdit();});
$('entryForm').addEventListener('change',e=>{if(e.target.id==='entrySeriesQuery')return;syncEntryFormLists(e.target);queueEntryEdit();});
$('entryForm').addEventListener('compositionstart',()=>{formComposing=true;syncNoticeBlocking();});
$('entryForm').addEventListener('compositionend',()=>{formComposing=false;syncNoticeBlocking();queueEntryEdit();});
$('retryEntrySave').onclick=()=>editId?entrySave.flush():formDraftSave.flush();
$('forkEntryDraft').onclick=async()=>{
  if(editId || formComposing || entryAdding || entryAddAttempt?.pending)return;
  if(formDraftRecord)clearRecoveryTracking(formDraftRecord.id);
  formDraftRecord={id:crypto.randomUUID(),version:0};draftWriteVersions.set(formDraftRecord.id,0);
  formDraftSave.schedule({id:formDraftRecord.id,draft:recoveryFormDraft()});if(await formDraftSave.flush()){resetEntryAddNotice();$('entryForm').elements.title.focus({preventScroll:true});}
};
function entryDraftSignature() {
  const {values,lists}=captureEntryDraft();return JSON.stringify({values,lists});
}
function resetEntryAddNotice() {
  $('entryAddState').hidden=true;$('entryAddState').textContent='';$('entryAddState').dataset.state='';
  for(const [control,description] of entryInvalidControls){control.removeAttribute('aria-invalid');if(description===null)control.removeAttribute('aria-describedby');else control.setAttribute('aria-describedby',description);}
  entryInvalidControls.clear();
}
function entryAddNotice(message,state='error',field='') {
  const status=$('entryAddState');status.hidden=false;status.textContent=message;status.dataset.state=state;
  const control=field && $('entryForm').elements[field];
  if(control){
    if(!entryInvalidControls.has(control))entryInvalidControls.set(control,control.getAttribute('aria-describedby'));
    control.setAttribute('aria-invalid','true');control.setAttribute('aria-describedby',[entryInvalidControls.get(control),'entryAddState'].filter(Boolean).join(' '));
    const details=control.closest('details');if(details)details.open=true;control.focus();
  }
}
function syncEntryAddLock() {
  syncNoticeBlocking();
  const locked=entryAdding || Boolean(entryAddAttempt?.pending) || entryDiscardOpen;
  $('entryForm').querySelector('.form-grid').inert=locked;
  $('entryForm').querySelector('.form-grid').setAttribute('aria-busy',String(entryAdding));
  for(const control of $('entryForm').querySelectorAll('.form-grid button,.form-grid input,.form-grid textarea,.form-grid select,.form-head [data-close],#cancelEntry,#forkEntryDraft')){
    if(locked){if(!entryLockedControls.has(control))entryLockedControls.set(control,control.disabled);control.disabled=true;}
    else if(entryLockedControls.has(control)){control.disabled=entryLockedControls.get(control);entryLockedControls.delete(control);}
  }
  $('createEntry').disabled=entryAdding || entryDiscardOpen || saveCoordinator.unconfirmed;
  if(entryAddAttempt?.pending&&entryAddAttempt.prepared&&!entryAdding&&!entryDiscardOpen){$('entryForm').querySelector('.form-head [data-close]').disabled=false;$('cancelEntry').disabled=false;$('cancelEntry').textContent='稍后继续';}
  else $('cancelEntry').textContent='取消';
}
function askEntryDiscard() {
  entryDiscardFocus=document.activeElement;entryDiscardOpen=true;syncEntryAddLock();
  $('entryAddActions').hidden=true;$('entryDiscard').hidden=false;$('entryAddState').hidden=true;$('keepEntry').focus();
}
function cancelEntryDiscard() {
  entryDiscardOpen=false;syncEntryAddLock();$('entryDiscard').hidden=true;$('entryAddActions').hidden=false;
  if($('entryAddState').textContent)$('entryAddState').hidden=false;
  const previous=entryDiscardFocus;
  (previous?.isConnected && !previous.disabled ? previous : $('entryForm').elements.title).focus({preventScroll:true});
}
$('keepEntry').onclick=cancelEntryDiscard;
$('discardEntry').onclick=async()=>{
  $('discardEntry').disabled=true;
  try{await formDraftSave.cancel();if(!await discardFormDraft()){if($('entryAddState').textContent)$('entryAddState').hidden=false;return;}
    entryDiscardOpen=false;formDirty=false;syncEntryAddLock();$('entryDiscard').hidden=true;$('entryAddActions').hidden=false;await hideDialog('entryDialog');
  }finally{$('discardEntry').disabled=false;}
};
$('entryForm').onsubmit=async e=> {
  e.preventDefault();if(formComposing || entryAdding || entryDiscardOpen||saveCoordinator.unconfirmed)return;if(editId){await entrySave.flush();return;}
  try {
    if(!entryAddAttempt){
      resetEntryAddNotice();
      const invalid=[...$('entryForm').elements].find(control=>control.willValidate&&!control.validity.valid);
      if(invalid){
        const messages={title:'请输入作品名称',total:'总集数需为 1–9999 的整数，也可留空',progress:'已看集数需为 0–9999 的整数',year:'首播年份需为 1888–2100 的整数，也可留空',customCover:'请输入公开网站的 HTTPS 图片链接'};
        entryAddNotice(messages[invalid.name] || '请检查这一项的内容','error',invalid.name);return;
      }
      const next=entryFromDraft(captureEntryDraft());
      entryAddAttempt={next,enrichQuery:manualEnrichQuery || next.title,payload:null,pending:false,prepared:false,record:formDraftRecord,draft:recoveryFormDraft()};
    }
    const attempt=entryAddAttempt;entryAdding=true;syncEntryAddLock();entryAddNotice('正在添加作品…','saving');$('entryAddState').focus();
    if(!attempt.prepared&&!await formDraftSave.flush()){entryAddAttempt=null;entryAddNotice('草稿尚未保存。请重试保存草稿后再添加，当前输入仍保留。');return;}
    const outcome=await performAddition(attempt);formDraftRecord=attempt.record;
    if(outcome.state==='completed'){
      entryAddAttempt=null;formDraftRecord=null;entryAdding=false;syncEntryAddLock();
      manualEnrichQuery='';formDirty=false;await hideDialog('entryDialog');
      const next=library.entries.find(item=>item.id===attempt.next.id);
      if(next){await openDetail(next);void enrichManualEntry(next.id,attempt.enrichQuery,next.type);}
      else toast('这次添加已完成，但作品目前已不在收藏中。未重复添加。');
    }else{
      attempt.pending=outcome.state==='pending';if(!attempt.pending)entryAddAttempt=null;
      entryAdding=false;syncEntryAddLock();$('createEntry').textContent=attempt.pending?'继续添加':'添加作品';
      entryAddNotice(attempt.pending?'添加结果尚未确认。内容已锁定，请继续同一次添加；不会重复收录。':`未添加：${errorMessage(outcome.error)}`);
      $('createEntry').focus();
    }
  }catch(error){if(entryAddAttempt?.payload){entryAddAttempt.pending=true;$('createEntry').textContent='继续添加';}entryAddNotice(errorMessage(error),'error',error.field || (!entryAddAttempt?'title':''));}
  finally{entryAdding=false;syncEntryAddLock();}
};
document.addEventListener('keydown',async e=> {
  if(e.isComposing || e.keyCode===229)return;
  // Let an open native picker handle dismissal before the enclosing dialog.
  if (e.target instanceof HTMLSelectElement && ['Escape','Tab'].includes(e.key) && CSS.supports('selector(select:open)') && e.target.matches(':open')) return;
  if (e.target.matches?.('[data-list-label],[data-series-label]') && ['Enter','Escape'].includes(e.key) && !e.isComposing) {
    e.preventDefault();
    const kind=e.target.dataset.listLabel?'list':'series',record=managerNameSaver(kind,e.target.dataset[`${kind}Label`]);
    if(record.composing)return;
    if (e.key === 'Escape') {e.target.value=managerNameLabel(kind,record.id);queueManagerName(e.target);}
    await record.save.flush();
    e.target.blur();
    return;
  }
  if (e.target.matches?.('[data-list-drag]') && ['ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const id = e.target.dataset.listDrag, movable = uiPreferences().lists.filter(list => list.kind !== 'all'), index = movable.findIndex(list => list.id === id);
    const nextIndex = index + (e.key === 'ArrowUp' ? -1 : 1);
    if (index < 0 || nextIndex < 0 || nextIndex >= movable.length) return;
    const target = document.querySelector(`[data-list-row="${CSS.escape(movable[nextIndex].id)}"]`);
    if (await moveList(id,target,e.key === 'ArrowUp')) document.querySelector(`[data-list-drag="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();return;}
  if (e.target.matches?.('[data-settings-tab]') && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
    const tabs = [...document.querySelectorAll('[data-settings-tab]')];
    const currentTab = tabs.indexOf(e.target);
    if (currentTab >= 0) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (currentTab + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateSettingsTab(tabs[next].dataset.settingsTab); tabs[next].focus();
    }
  }
  if (e.target.matches?.('[data-tool-tab]') && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
    const tabs = [...document.querySelectorAll('[data-tool-tab]')];
    const currentTab = tabs.indexOf(e.target);
    if (currentTab >= 0) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (currentTab + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      toolTabs(tabs[next].dataset.toolTab); tabs[next].focus();
    }
  }
  if(e.key==='Escape') {
    if(!activeDialog&&!current&&$('entryRecoveryMenu').open){e.preventDefault();recoveryDiscard=null;editDiscardId='';recoveryDeleteError='';renderEntryRecovery();$('entryRecoveryMenu').open=false;$('entryRecoverySummary').focus();return;}
    if (!activeDialog && !current && $('sortMenu')?.open) { $('sortMenu').open = false; e.preventDefault(); return; }
    if (!activeDialog && !current && $('filters')?.open) { $('filters').open = false; e.preventDefault(); return; }
    if(activeDialog)hideDialog(activeDialog); else if(current)closeDetail(); else { document.body.classList.remove('menu-open'); syncNav(); }
  }
  if(workspace==='search' && !activeDialog && !current && ['ArrowUp','ArrowDown','Enter'].includes(e.key) && e.target===$('searchInput')) {
    if(e.key==='Enter'){e.preventDefault();if(selected>=0&&results[selected])openDetail(results[selected]);else remoteSearch();}
    else {e.preventDefault();selected=Math.max(0,Math.min(results.length-1,selected+(e.key==='ArrowDown'?1:-1)));document.querySelectorAll('[data-result]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.result)===selected));document.querySelector(`[data-result="${selected}"]`)?.scrollIntoView({block:'nearest'});}
  }
  if(e.key==='Tab' && (activeDialog || current)) {
    if(!saveCoordinator.unconfirmed){
      if(detailAdding&&!activeDialog){e.preventDefault();$('detailAddState')?.focus();return;}
      if(activeDialog==='entryDialog'&&entryAdding){e.preventDefault();$('entryAddState').focus();return;}
      if(dataOperation && activeDialog==='dataDialog'){e.preventDefault();$(dataOperationFocus).focus();return;}
    }
    const parent=activeDialog==='entryDialog'&&entryDiscardOpen&&!saveCoordinator.unconfirmed?$('entryDiscard'):activeDialog?$(activeDialog):$('detailDrawer');
    const focusable=[...parent.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(el=>!el.hidden && !el.closest('[inert]') && el.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
});
window.addEventListener('beforeunload',e=>{if(dirty||formDirty&&(editId||formComposing||formDraftSave.dirty||!formDraftRecord?.version)||saving||entryAddAttempt?.pending&&!entryAddAttempt.prepared||detailAddAttempt?.pending&&!detailAddAttempt.prepared||dataOperation||pendingDataResult()||settingsSave.dirty||noteSave.dirty||managerNamesDirty()){e.preventDefault();e.returnValue='';}});
async function init() {
  let libraryRead=false;
  if($('editRecoveryRepair')){$('toastHome').append($('editRecoveryRepair'));$('editRecoveryRepair').hidden=true;}
  restoreWorkspaceState();
  applyPreferences(); renderNav();
  $('posterGrid').setAttribute('aria-busy','true');
  $('addWork').disabled = true;
  $('posterGrid').innerHTML = '<div class="load-state" role="status" aria-live="polite">读取档案…</div>';
  $('emptyState').hidden = true;
  try {
    const loadedLibrary=await api('/api/library');
    library={...loadedLibrary,settings:preferences(loadedLibrary.settings)};
    libraryRead=true;
    const pendingEdits=await initializeEditRecovery();
    timelineField='premiere';
    loaded=true;
    for(const record of pendingEdits)void commit(()=>library.entries,'',undefined,{fixedPayload:record.payload});
    $('posterGrid').setAttribute('aria-busy','false');
    $('addWork').disabled = false;
    applyPreferences();renderNav();
    if (workspace === 'collection') render(); else openWorkspace(workspace);
    if (workspace !== 'sources') await health();
    void loadEntryRecovery();
  }
  catch(e){
    $('posterGrid').setAttribute('aria-busy','false');
    if(libraryRead){
      editRecoveryError=errorMessage(e);loaded=false;renderEntryRecovery();
      $('posterGrid').innerHTML=`<div class="load-error"><h3>未完成编辑暂时无法读取</h3><p>${esc(e.message)}。作品档案已读取，未修改；请导出并检查本机恢复记录。</p><div class="load-error-actions"><button class="primary-btn" id="inspectRecoveryLoad">检查恢复记录</button><button class="text-btn" id="retryLoad">重新读取</button></div></div>`;
      $('retryLoad').onclick=init;$('inspectRecoveryLoad').onclick=showEditRecoveryRepair;return;
    }
    $('posterGrid').innerHTML=`<div class="load-error"><h3>${e.migrationPending?'迁移暂未结束':'档案暂时无法读取'}</h3><p>${esc(e.message)}</p><div class="load-error-actions"><button class="primary-btn" id="openRecovery">${e.migrationPending?'检查迁移与备份':'查看本地快照'}</button><button class="text-btn" id="retryLoad">重新连接</button></div></div>`;
    $('retryLoad').onclick=init;
    $('openRecovery').onclick=()=>{settingsTab='data';loadSettings();showDialog('dataDialog');};
    toast('未能读取档案，已暂停保存以保护原数据。');
  }
}
init();
