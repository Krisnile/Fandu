import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { makeServer } from '../server.mjs';
import {randomUUID} from 'node:crypto';
import {librarySavePayload} from '../src/library-save.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const archive = resolve(process.env.FANDU_ARCHIVE || new URL('../data/library.json', import.meta.url).pathname);
const source = JSON.parse(await readFile(archive, 'utf8'));
assert.ok(Array.isArray(source.entries) && source.entries.length, '真实档案中没有可验收的作品');

const root = await mkdtemp(join(tmpdir(), 'fandu-library-qa-'));
const dataDir = join(root, 'data');
const output = process.env.FANDU_QA_OUTPUT ? resolve(process.env.FANDU_QA_OUTPUT) : join(root, 'screenshots');
await mkdir(dataDir, { recursive: true });
await mkdir(output, { recursive: true });
await copyFile(archive, join(dataDir, 'library.json'));

const server = makeServer({ dataDir });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  // Exercise v0/v1 -> v2 and receipt normalization on the isolated real-data
  // copy, including records whose creation date is legitimately unknown.
  const headers={'X-Yingjian':'1','Content-Type':'application/json'};
  const initialResponse=await fetch(base+'/api/library',{headers});assert.equal(initialResponse.status,200);const initial=await initialResponse.json();
  const payload=librarySavePayload({...initial,requestId:randomUUID()});
  const savedResponse=await fetch(base+'/api/library/save',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(savedResponse.status,200);const saved=await savedResponse.json();
  assert.equal(saved.state,'completed');assert.equal(saved.library.formatVersion,2);assert.deepEqual(saved.library.entries,initial.entries);assert.deepEqual(saved.library.settings,initial.settings);
  const retryResponse=await fetch(base+'/api/library/save',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(retryResponse.status,200);const retry=await retryResponse.json();assert.equal(retry.replayed,true);assert.equal(retry.library.revision,saved.library.revision);
  assert.equal(JSON.parse(await readFile(join(dataDir,'library.json'),'utf8')).formatVersion,2);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/image?**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#17334a"/><circle cx="225" cy="82" r="54" fill="#79aeb5"/><path d="M0 370L205 150L300 420H0" fill="#102638"/></svg>'
  }));

  const started = performance.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#collectionOverview').waitFor({ state: 'visible' });
  const overviewMs = Math.round(performance.now() - started);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '桌面收藏总览不应横向溢出');

  const preferred = source.settings?.lists?.find(list => list.status === 'completed') || source.settings?.lists?.find(list => list.kind !== 'all');
  assert.ok(preferred, '真实档案至少需要一个子列表');
  const expected = source.entries.filter(entry => preferred.kind === 'status' ? entry.status === preferred.status : entry.lists?.includes(preferred.id)).length;
  await page.locator(`[data-view="${preferred.id}"]`).click();
  await page.locator('.poster-card').first().waitFor();
  const firstBatch = await page.locator('.poster-card').count();
  assert.equal(firstBatch, Math.min(expected, 120), '连续浏览首批应严格限制为 120 条');
  assert.equal(await page.locator('#posterGrid').evaluate(grid => grid.classList.contains('list-mode')), source.settings?.view === 'list');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '桌面大列表不应横向溢出');
  if (expected > 120 && source.settings?.rows === 0) assert.equal(await page.locator('#loadMoreEntries').isVisible(), true, '大列表应提供继续加载');
  await page.screenshot({ path: join(output, 'collection-large-desktop.png'), fullPage: false });

  await page.locator('#toggleSelection').click();
  await page.locator('#batchSelectVisible').click();
  assert.equal(await page.locator('#batchCount').textContent(), `已选 ${firstBatch} 部`, '全选当前页应覆盖大库首批的全部可见作品');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '桌面批量工具条不应让大列表横向溢出');
  await page.screenshot({ path: join(output, 'batch-large-desktop.png'), fullPage: false });
  await page.locator('#toggleSelection').click();

  await page.locator('.poster-open').first().click();
  await page.locator('#detailDrawer').waitFor({ state: 'visible' });
  const drawer = await page.locator('#detailDrawer').boundingBox();
  assert.ok(drawer.width <= 520 && drawer.height <= 960, '详情侧栏应保持在当前视口内');
  await page.screenshot({ path: join(output, 'detail-large-desktop.png'), fullPage: false });
  await page.locator('#closeDrawer').click();

  await page.locator('[data-tools-open]').click();
  await page.locator('[data-tool-hub="timeline"]').click();
  await page.locator('.timeline-item').first().waitFor();
  const timelineBatch = await page.locator('.timeline-item').count();
  assert.ok(timelineBatch <= 120, '时间轴首批不得超过 120 条');
  if (source.entries.length > 120) assert.equal(await page.locator('#timelineMore').isVisible(), true, '大库时间轴应提供继续加载');
  await page.screenshot({ path: join(output, 'timeline-large-desktop.png'), fullPage: false });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await mobile.emulateMedia({ reducedMotion: 'reduce' });
  await mobile.route('**/api/image?**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#17334a"/><circle cx="225" cy="82" r="54" fill="#79aeb5"/><path d="M0 370L205 150L300 420H0" fill="#102638"/></svg>'
  }));
  await mobile.goto(base, { waitUntil: 'domcontentloaded' });
  await mobile.locator('#collectionOverview').waitFor({ state: 'visible' });
  await mobile.locator('#mobileMenu').click();
  await mobile.locator(`[data-view="${preferred.id}"]`).click();
  await mobile.locator('.poster-card').first().waitFor();
  assert.equal(await mobile.evaluate(() => matchMedia('(hover:none) and (pointer:coarse)').matches), true, '移动验收必须使用真实触屏媒体能力');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '移动端大列表不应横向溢出');
  assert.equal(await mobile.locator('#posterGrid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 1, '移动端列表必须收为单列');
  await mobile.locator('.poster-card').nth(1).hover({ force: true });
  const touchDisclosure = await mobile.locator('.poster-card').nth(1).evaluate(card => ({
    hovering: card.matches(':hover'),
    meta: getComputedStyle(card.querySelector('.poster-info p')).visibility,
    cover: card.querySelector('.cover-meta') ? getComputedStyle(card.querySelector('.cover-meta')).visibility : 'hidden'
  }));
  if (touchDisclosure.hovering) {
    assert.equal(touchDisclosure.meta, 'hidden', '触屏的黏性悬停不应暴露辅助资料');
    assert.equal(touchDisclosure.cover, 'hidden', '触屏的黏性悬停不应覆盖封面');
  }
  await mobile.screenshot({ path: join(output, 'collection-large-mobile.png'), fullPage: false });

  const mobileBatch = await mobile.locator('.poster-card').count();
  await mobile.locator('#toggleSelection').click();
  await mobile.locator('#batchSelectVisible').click();
  assert.equal(await mobile.locator('#batchCount').textContent(), `已选 ${mobileBatch} 部`, '移动端全选当前页应覆盖全部可见作品');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '移动端批量工具条不应横向溢出');
  await mobile.screenshot({ path: join(output, 'batch-large-mobile.png'), fullPage: false });
  await mobile.locator('#toggleSelection').click();

  await mobile.locator('#mobileMenu').click();
  await mobile.locator('#openSettings').click();
  await mobile.locator('[data-settings-tab="list"]').click();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '移动端列表管理不应横向溢出');
  assert.equal(await mobile.locator('#listManager [data-list-row]').count(), source.settings?.lists?.length || 0, '列表管理应完整渲染当前列表');
  await mobile.screenshot({ path: join(output, 'settings-list-large-mobile.png'), fullPage: false });
  await mobile.close();

  console.log(JSON.stringify({
    passed: true,
    archive,
    output,
    entries: source.entries.length,
    checkedList: preferred.label,
    checkedItems: expected,
    firstBatch,
    timelineBatch,
    overviewMs
  }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
