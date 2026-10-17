import test from 'node:test';
import assert from 'node:assert/strict';
import { Sources, mapYucSeason } from '../lib/sources.mjs';
const noYuc = async () => { throw Error('Yuc offline'); };
test('season browsing keeps pagination, Japanese title, and caches repeated pages', async () => {
  const urls=[];
  const sources=new Sources({request:async url=>{
    urls.push(url);return {data:[{mal_id:100,title:'Orbit',title_japanese:'軌道',titles:[{type:'English',title:'The Orbit'}],type:'TV',aired:{from:'2026-07-10'},episodes:12,studios:[{name:'Orbit Studio'}],broadcast:{day:'Fridays',time:'23:00',timezone:'Asia/Tokyo'}}],pagination:{has_next_page:true,items:{total:72}}};
  },requestText:noYuc});
  const first=await sources.season(2026,'夏',1);
  assert.equal(first.hasNext,true);assert.equal(first.total,72);assert.equal(first.results[0].originalTitle,'軌道');
  assert.ok(first.results[0].aliases.includes('The Orbit'));
  assert.equal(first.results[0].broadcastDay,5);assert.equal(first.results[0].broadcastTime,'23:00');assert.deepEqual(first.results[0].studios,['Orbit Studio']);
  assert.equal((await sources.season(2026,'夏',1)).state,'cached');
  await sources.season(2026,'夏',2);
  assert.equal(urls.length,2);assert.match(urls[1],/2026\/summer\?page=2&/);
  for(const args of [[2026,'__proto__',1],[2026,'夏',0],[2026,'夏',101],[2026,'夏',1.5],[9999,'夏',1]]) await assert.rejects(sources.season(...args),/季度参数无效/);
});

test('season browsing falls back to Kitsu when Jikan is unavailable', async () => {
  const urls=[];
  const sources=new Sources({request:async url=>{
    urls.push(url);
    if (url.includes('api.jikan.moe')) throw Error('Jikan timeout');
    return {data:[{id:'51029',attributes:{canonicalTitle:'备用季度作品',titles:{ja_jp:'备用季度作品'},showType:'TV',startDate:'2026-07-08',episodeCount:12,averageRating:'82.0',synopsis:'备用资料'}}],meta:{count:1},links:{}};
  },requestText:noYuc});
  const result=await sources.season(2026,'夏',1);
  assert.equal(result.source,'kitsu');
  assert.equal(result.total,1);
  assert.equal(result.results[0].title,'备用季度作品');
  assert.equal(result.results[0].year,2026);
  assert.equal(urls.length,2);
  assert.match(urls[1],/filter%5Bseason%5D=summer/);
  assert.match(urls[1],/filter%5Byear%5D=2026/);
});

test('Yuc seasonal pages map the schedule into remote entries', async () => {
  const fixture = `<!--周一--><div class="div_date"><p class="imgtext4">25:00~</p><p class="imgep">(全12话)</p><img data-src="https://i0.hdslb.com/bfs/new_dyn/poster.jpg"></div><div><table><tr><td class="date_title_">远程季度作品<br>第二行</td></tr></table></div><!--#A01--><p class="title_cn_r">远程季度作品 第二行</p><p class="title_jp_r">遠程クール作品</p><td class="type_a_r">原创动画</td><td class="type_tag_r">奇幻/冒险</td>动画制作：星环工作室<br>`;
  const items = mapYucSeason(fixture, 2026, '夏', 'https://yuc.wiki/202607/');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '远程季度作品 第二行');
  assert.equal(items[0].originalTitle, '遠程クール作品');
  assert.equal(items[0].total, 12);
  assert.equal(items[0].broadcastDay, 1);
  assert.equal(items[0].broadcastTime, '');
  assert.equal(items[0].broadcastLabel, '25:00');
  assert.equal(items[0].seasonNew, true);
  assert.equal(items[0].cover, 'https://i0.hdslb.com/bfs/new_dyn/poster.jpg');
  assert.deepEqual(items[0].studios, ['星环工作室']);
});

test('Yuc is preferred for a quarter and remains cached', async () => {
  const fixture = `<!--周一--><div class="div_date"><p class="imgtext4">20:30~</p><p class="imgep">(全12话)</p><img data-src="https://i0.hdslb.com/bfs/new_dyn/poster.jpg"></div><div><table><tr><td class="date_title_">缓存季度作品</td></tr></table></div>`;
  let textCalls = 0;
  const sources = new Sources({request: async () => { throw Error('JSON source should not be reached'); }, requestText: async () => { textCalls++; return fixture; }});
  const first = await sources.season(2026, '夏', 1);
  assert.equal(first.source, 'yuc');
  assert.equal(first.results[0].title, '缓存季度作品');
  assert.equal((await sources.season(2026, '夏', 1)).state, 'cached');
  assert.equal(textCalls, 1);
});

test('Yuc-only quarter mode remains available when JSON fallbacks are disabled', async () => {
  const fixture = `<!--周三--><div class="div_date"><p class="imgtext4">21:00~</p><p class="imgep">(全12话)</p><img data-src="https://i0.hdslb.com/bfs/new_dyn/yuc-only.jpg"></div><div><table><tr><td class="date_title_">固定季度来源</td></tr></table></div>`;
  const sources = new Sources({ request: async () => { throw Error('JSON fallback should not be reached'); }, requestText: async () => fixture });
  const result = await sources.season(2026, '夏', 1, 'yuc');
  assert.equal(result.source, 'yuc');
  assert.equal(result.results[0].title, '固定季度来源');
  assert.equal(result.results[0].broadcastDay, 3);
});

test('Yuc certificate rollover uses the fixed HTTPS Reader mirror', async () => {
  const fixture = `<!--#A01--><div><img data-src="https://i0.hdslb.com/bfs/new_dyn/reader.jpg"><p class="title_cn_r">证书切换季度作品</p></div>`;
  const urls = [];
  const options = [];
  const sources = new Sources({
    request: async () => { throw Error('JSON fallback must not be reached'); },
    requestText: async (url, requestOptions) => {
      urls.push(url);
      options.push(requestOptions || {});
      if (url.startsWith('https://yuc.wiki/')) {
        const error = Error('fetch failed'); error.cause = { code:'CERT_HAS_EXPIRED' }; throw error;
      }
      return fixture;
    }
  });
  const result = await sources.season(2026, '夏', 1, 'yuc');
  assert.equal(result.source, 'yuc');
  assert.equal(result.results[0].title, '证书切换季度作品');
  assert.deepEqual(urls, ['https://yuc.wiki/202607/', 'https://r.jina.ai/http://yuc.wiki/202607/']);
  assert.equal(options[1].timeoutMs, 12_000);
  assert.equal(options[1].attempts, 1);
});

test('Yuc announced-only pages remain searchable before a weekly schedule exists', () => {
  const fixture = `<!--#A01--><div><img data-src="https://i0.hdslb.com/bfs/new_dyn/future.jpg"><p class="title_cn_r">待排播作品</p><p class="title_jp_r">放送前タイトル</p><td class="type_a_r">原创动画</td><td class="type_tag_r">科幻/冒险</td>动画制作：未来工作室</div>`;
  const items = mapYucSeason(fixture, 2026, '秋');
  assert.equal(items.length, 1);
  assert.equal(items[0].seasonNew, true);
  assert.equal(items[0].title, '待排播作品');
  assert.equal(items[0].cover, 'https://i0.hdslb.com/bfs/new_dyn/future.jpg');
});
