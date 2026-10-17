import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
import {Sources} from '../lib/sources.mjs';
import {entry} from '../src/model.js';
import {waitForAsync} from './qa-poll.mjs';
import {auditTextContrast} from './text-contrast.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output=await mkdtemp(join(tmpdir(),'fandu-theme-ui-')),sources=new Sources();
const sample=entry({id:'theme:1',title:'星海巡航',originalTitle:'Star Ocean Voyage',type:'anime',year:2026,season:'夏',region:'日本',total:12,progress:4,status:'watching',rating:4,score:8.2,tags:['太空歌剧'],seriesId:'space',description:'在边界之外，寻找下一站。记录旅途中的作品，也记录每一次观看的感受。',note:'下一站，异世界。',cover:'https://lain.bgm.tv/pic/cover/l/theme.jpg'});
sources.search=async provider=>({state:'ok',results:[entry({...sample,id:provider+':theme',sourceId:provider+':theme',status:'planned'})]});
sources.season=async(year,season)=>({state:'ok',results:[entry({...sample,id:'yuc:theme',sourceId:'yuc:theme',year:Number(year),season,broadcastDay:2,broadcastTime:'23:30',broadcastTimezone:'Asia/Tokyo',studios:['Orbit Studio'],seasonNew:true})],source:'yuc',hasNext:false,total:1});
const server=makeServer({dataDir:join(output,'data'),sources});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'X-Yingjian':'1','Content-Type':'application/json'};
const initial=await (await fetch(base+'/api/library',{headers})).json();
await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({...initial,entries:[sample,entry({...sample,id:'theme:2',title:'边界之外：通往下一个世界的漫长旅程与所有值得记录的风景',type:'movie',status:'completed',total:1,progress:1,year:2024,season:'春',tags:['长片名测试'],cover:''})],settings:{...initial.settings,series:[{id:'space',label:'星海系列'}],tags:['太空歌剧','长片名测试']}})});
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const probe=await browser.newPage();
  await probe.setContent('<section id="probe" style="background:#fff;color:#000"><p id="near" style="color:#777">Near threshold</p><p id="large" style="color:#777;font-size:30px">Large type</p><input type="checkbox" value="on"><p id="faded" style="opacity:.5">Opacity group</p><style>#photo::before{content:"";background:linear-gradient(#fff,#000)}</style><div id="photo"><b>Gradient layer</b></div></section>');
  const proof=await probe.evaluate(auditTextContrast,'#probe');
  assert.ok(proof.failures.some(item=>item.id==='near'),'近似 4.5 的失败不可四舍五入成通过');
  assert.ok(proof.samples.some(item=>item.id==='large'&&item.ratio>=item.threshold));
  assert.ok(proof.review.some(item=>item.id==='faded'));assert.ok(proof.review.some(item=>item.text==='Gradient layer'));
  assert.equal(proof.samples.some(item=>item.text==='on'),false,'复选框内部 value 不是可见文字');
  await probe.close();
  const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);await page.emulateMedia({reducedMotion:'reduce'});
  const errors=[],results=[];let discardDialogs=0;page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{discardDialogs++;await dialog.dismiss();});
  await page.route('**/api/image?**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#214c63"/><circle cx="220" cy="90" r="65" fill="#73abb3"/><path d="M0 360L220 140L300 420H0" fill="#143344"/></svg>'}));
  await page.goto(base);await page.locator('#collectionOverview').waitFor();
  const openNav=async selector=>{
    if(page.viewportSize().width<=920){
      await page.waitForFunction(()=>document.querySelector('.sidebar').inert===!document.body.classList.contains('menu-open'));
      if(!await page.locator('body').evaluate(node=>node.classList.contains('menu-open')))await page.locator('#mobileMenu').click();
      await page.waitForFunction(()=>!document.querySelector('.sidebar').inert&&document.querySelector('.sidebar').getBoundingClientRect().left>=0);
    }
    await page.locator(selector).click();
  };
  const capture=async(name,theme,mode,root='.app-shell',hover='')=>{
    await page.mouse.move(0,0);if(hover)await page.locator(hover).hover();await page.locator('#toasts .toast-dismiss').evaluateAll(nodes=>nodes.forEach(node=>node.click()));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${theme}/${mode}/${name} 横向溢出`);
    assert.equal(await page.evaluate(()=>document.querySelector('meta[name=theme-color]').content===getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()),true,'浏览器界面色应跟随实际主题表面');
    const markers=await page.evaluate(()=>{
      const probe=document.createElement('span');probe.style.color='var(--accent-text)';document.body.append(probe);const expected=getComputedStyle(probe).color;probe.style.color='var(--on-accent-fill)';const knob=getComputedStyle(probe).color;probe.remove();
      const selectors=['.choice-pill[aria-pressed=true]','.theme-swatch[aria-checked=true]','.layout-toggle .active','button.timeline-decade.active','.catalog-option.active','.season-year[aria-pressed=true]','.entry-panel .list-membership label:has(input:checked)','.detail-lists label:has(input:checked)','.source-enabled input:checked'];
      const failures=[];
      for(const selector of selectors)for(const node of document.querySelectorAll(selector)){
        if(!node.checkVisibility()||node.closest('[inert]'))continue;
        const style=getComputedStyle(node);
        if(style.borderTopColor!==expected||style.borderTopStyle!=='solid'||parseFloat(style.borderTopWidth)<1)failures.push(selector+' border');
        if(node.matches('.source-enabled input')&&getComputedStyle(node,'::after').backgroundColor!==knob)failures.push(selector+' knob');
      }
      for(const node of document.querySelectorAll('.nav-item.active,.nav-folder.active')){
        if(node.checkVisibility()&&!node.closest('[inert]')&&!getComputedStyle(node).boxShadow.includes(expected))failures.push('navigation selected marker');
      }
      return failures;
    });
    assert.deepEqual(markers,[],`${theme}/${mode}/${name} 选中标记需要独立的可读颜色`);
    const audit=await page.evaluate(auditTextContrast,root);
    const viewport=page.viewportSize().width;
    results.push({theme,mode,page:name,viewport,...audit});
    await page.screenshot({path:join(output,`${theme}-${mode}-${viewport}-${name}.png`)});
  };
  const focusFrame=async(selector,shell='')=>{
    await page.locator(selector).focus();
    const valid=await page.locator(shell||selector).evaluate((node,shell)=>{
      const probe=document.createElement('span');probe.style.color='var(--accent-text)';document.body.append(probe);const expected=getComputedStyle(probe).color;probe.remove();
      const style=getComputedStyle(node);
      return shell?style.boxShadow.includes(expected)&&style.boxShadow.includes('2px'):style.outlineColor===expected&&style.outlineStyle==='solid'&&parseFloat(style.outlineWidth)>=2;
    },shell);
    assert.equal(valid,true,selector+' 需要完整、可读的键盘焦点框');
  };
  const focusPoster=async()=>{
    await page.keyboard.press('Tab');await page.locator('.poster-open').first().focus();
    assert.equal(await page.locator('.poster-open').first().evaluate(node=>node.matches(':focus-visible')),true,'海报必须真正进入键盘焦点态');
    await focusFrame('.poster-open');
    // A settings save may replace the cards before ResizeObserver receives
    // the first width. Observe that width first, then require a subsequent
    // card replacement; otherwise two rapid resizes can coalesce into none.
    await page.evaluate(()=>{
      window.qaPosterResizeObserver=new ResizeObserver(()=>{window.qaPosterResize={width:innerWidth,node:document.querySelector('.poster-open')};});
      window.qaPosterResizeObserver.observe(document.querySelector('#posterGrid'));
    });
    try{for(const width of [1180,1280]){
      await page.evaluate(()=>{window.qaPosterResize=null;});
      await page.setViewportSize({width,height:850});
      try{await page.waitForFunction(width=>window.qaPosterResize?.width===width&&window.qaPosterResize.node&&!window.qaPosterResize.node.isConnected,width);}catch(error){console.error(JSON.stringify({output,resize:await page.evaluate(()=>({width:innerWidth,gridWidth:document.querySelector('#posterGrid').clientWidth,observedWidth:window.qaPosterResize?.width,oldConnected:window.qaPosterResize?.node?.isConnected,focus:document.activeElement?.outerHTML.slice(0,160),dialog:[...document.querySelectorAll('.dialog-backdrop')].filter(node=>!node.hidden).map(node=>node.id)}))}));throw error;}
      assert.equal(await page.locator('.poster-open').first().evaluate(node=>document.activeElement===node&&node.matches(':focus-visible')),true,'窗口尺寸重绘后应保留同一作品的键盘焦点');
    }}finally{await page.evaluate(()=>window.qaPosterResizeObserver.disconnect());}
    assert.equal(await page.locator('.poster-card .tag-chips').first().evaluate(node=>getComputedStyle(node).visibility==='visible'),true,'键盘焦点也应披露标签');
    const overlap=await page.locator('.poster-card').first().evaluate(card=>{
      const button=card.querySelector('.card-actions button'),paragraph=card.querySelector('.poster-info p');
      if(!button)return false;
      const box=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(paragraph);
      return [...range.getClientRects()].some(text=>text.left<box.right&&text.right>box.left&&text.top<box.bottom&&text.bottom>box.top);
    });
    assert.equal(overlap,false,'快速 +1 不能遮挡展开后的文字');
  };
  const desktopPages=async(theme,mode)=>{
    await openNav('[data-view=library]');await capture('overview',theme,mode);
    await openNav('[data-view=watching]');await page.locator('[data-layout-mode=grid]').click();await capture('collection-grid',theme,mode);
    await focusPoster();await capture('collection-focus',theme,mode);
    await page.locator('[data-layout-mode=list]').click();await capture('collection-list',theme,mode);
    await capture('primary-hover',theme,mode,'.app-shell','#addWork');
    await page.locator('.poster-open').first().click();await capture('detail',theme,mode,'#detailDrawer');await page.locator('#closeDrawer').click();
    await page.locator('#addWork').click();await capture('entry',theme,mode,'#entryDialog');
    await page.locator('#entryDialog .extra-fields summary').click();await focusFrame('#entrySeriesQuery');
    await page.locator('#entryTagInput').fill('太空歌剧');await page.locator('#entryTagInput').press('Enter');await focusFrame('#entryTagInput','#entryTagPicker');await capture('entry-metadata',theme,mode,'#entryDialog');await page.locator('#cancelEntry').click();await page.locator('#entryDiscard').waitFor();await capture('entry-discard',theme,mode,'#entryDialog');await page.locator('#discardEntry').click();await page.locator('#entryDialog').waitFor({state:'hidden'});
    await openNav('[data-search-open]');await page.locator('#searchInput').fill('星海');await page.locator('#searchInput').press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.result-item').length>0&&document.querySelector('#searchResults').getAttribute('aria-busy')==='false');await focusFrame('#searchInput','.search-input-wrap');await capture('search',theme,mode);
    await openNav('[data-source-open]');await page.locator('#sourceStatusList article').first().waitFor();await capture('sources',theme,mode);
    await openNav('[data-tools-open]');await capture('tools-home',theme,mode);
    await page.locator('[data-tool-hub=timeline]').click();await capture('timeline',theme,mode);
    await page.locator('[data-tool-tab=catalog]').click();await capture('catalog',theme,mode);
    await page.locator('[data-tool-tab=season]').click();await page.waitForFunction(()=>document.querySelector('#toolSeason .season-work'));await capture('season',theme,mode);
    await page.locator('[data-tool-tab=maintenance]').click();await page.locator('#runDataAudit').click();await capture('maintenance',theme,mode);
    await openNav('#openSettings');
    for(const tab of ['general','list','tags','series','data','about']){
      await page.locator(`[data-settings-tab=${tab}]`).click();
      if(tab==='data')await page.waitForFunction(()=>document.querySelector('#backupState').dataset.busy==='false');
      if(tab==='tags')await focusFrame('#tagSearch','#settingsTags .tag-search');
      if(tab==='series')await focusFrame('#seriesSearch','.series-manager-toolbar .tag-search');
      await capture('settings-'+tab,theme,mode,'#dataDialog');
      if(tab==='data')await capture('export-hover',theme,mode,'#dataDialog','#exportTransfer');
    }
    await page.locator('[data-close=dataDialog]').click();
  };
  for(const theme of ['blue','violet','cyan','amber','graphite'])for(const mode of ['dark','light']){
    await page.setViewportSize({width:1280,height:850});await openNav('#openSettings');await page.locator('[data-settings-tab=general]').click();
    await page.locator(`.theme-palette [data-choice=${theme}]`).click();await page.locator('#modeSelect').selectOption(mode);
    await waitForAsync(page,async([theme,mode])=>{const value=await(await fetch('/api/library',{headers:{'X-Yingjian':'1'}})).json();return value.settings.theme===theme&&value.settings.mode===mode;},[theme,mode]);
    await page.locator('[data-close=dataDialog]').click();await desktopPages(theme,mode);
    await page.setViewportSize({width:390,height:844});await openNav('[data-view=watching]');await page.locator('[data-layout-mode=grid]').click();await capture('collection-grid',theme,mode);
    await page.locator('.poster-open').first().click();await capture('detail',theme,mode,'#detailDrawer');await page.locator('#closeDrawer').click();
    await openNav('[data-source-open]');await capture('sources',theme,mode);
    await openNav('#openSettings');await page.locator('[data-settings-tab=general]').click();await capture('settings-general',theme,mode,'#dataDialog');
    await page.locator('[data-settings-tab=data]').click();await page.waitForFunction(()=>document.querySelector('#backupState').dataset.busy==='false');await capture('settings-data',theme,mode,'#dataDialog');await page.locator('[data-close=dataDialog]').click();
    console.log(JSON.stringify({theme,mode,captured:results.length,failures:results.filter(item=>item.theme===theme&&item.mode===mode).reduce((sum,item)=>sum+item.failures.length,0)}));
  }
  await page.setViewportSize({width:1280,height:850});
  for(const mode of ['dark','light'])for(const accent of ['#ffffff','#000000','#777777','#ff0000','#00ff00','#0000ff']){
    const label='custom-'+accent.slice(1);
    await openNav('#openSettings');await page.locator('[data-settings-tab=general]').click();await page.locator('#modeSelect').selectOption(mode);await page.locator('#accentColor').fill(accent);
    await waitForAsync(page,async([mode,accent])=>{const value=await(await fetch('/api/library',{headers:{'X-Yingjian':'1'}})).json();return value.settings.mode===mode&&value.settings.accent===accent;},[mode,accent]);
    await capture('settings-general',label,mode,'#dataDialog');await page.locator('[data-close=dataDialog]').click();
    await openNav('[data-source-open]');await capture('sources',label,mode);
    await openNav('[data-view=watching]');await focusPoster();await capture('collection-focus',label,mode);
  }
  assert.deepEqual(errors,[]);
  assert.equal(discardDialogs,0,'草稿确认使用页内操作，不触发系统对话框');
  await writeFile(join(output,'contrast-report.json'),JSON.stringify(results,null,2));
  const failures=results.flatMap(({theme,mode,page,viewport,failures})=>failures.map(item=>({theme,mode,page,viewport,...item})));
  const summary={passed:failures.length===0,output,screens:results.length,solidTextSamples:results.reduce((sum,item)=>sum+item.samples.length,0),manualReviewSamples:results.reduce((sum,item)=>sum+item.review.length,0),failures:failures.length};
  console.log(JSON.stringify(summary));
  if(!process.env.THEME_QA_REPORT_ONLY)assert.equal(failures.length,0,'See contrast-report.json for solid-background text failures; image/gradient text requires manual review');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
