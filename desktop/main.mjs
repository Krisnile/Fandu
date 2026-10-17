import {app,BrowserWindow,Menu,dialog,net,protocol,screen,session,shell} from 'electron';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {join,isAbsolute,basename} from 'node:path';
import {once} from 'node:events';
import {APP_URL,internalUrl,internalNavigation,externalUrl,windowState} from './policy.mjs';
import {MAX_TRANSFER_BYTES} from '../src/backup.js';

// Register synchronously: a standard origin keeps IndexedDB stable across ports,
// application restarts and desktop upgrades. Never expose the service token.
protocol.registerSchemesAsPrivileged([{scheme:'fandu',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.setName('Fandu');
const override=process.env.FANDU_DESKTOP_PROFILE;
if(override&&!isAbsolute(override))throw Error('FANDU_DESKTOP_PROFILE 必须是绝对路径');
const profile=override||join(app.getPath('appData'),'Fandu');
app.setPath('userData',profile);
const qa=Boolean(override&&process.env.FANDU_DESKTOP_QA==='1');
let window,server,origin,serviceReady=false,windowTask,quitRequested=false,shutdownTask,boundsTimer,lastBounds,startupError,boundsTask=Promise.resolve();
const token=randomBytes(32).toString('hex');
const boundsPath=join(profile,'window-state.json');
let atomicBytes;

function saveBounds(){
  clearTimeout(boundsTimer);
  if(window&&!window.isDestroyed())lastBounds={...window.getNormalBounds(),maximized:window.isMaximized()};
  if(lastBounds&&atomicBytes)boundsTask=boundsTask.catch(()=>{}).then(()=>atomicBytes(boundsPath,Buffer.from(JSON.stringify(lastBounds))));
  return boundsTask;
}
async function shutdown(){
  if(shutdownTask)return shutdownTask;
  shutdownTask=(async()=>{
    let failure=startupError;
    try{await saveBounds();}catch(error){console.error('窗口位置未保存：',error.message);}
    if(server){const timer=setTimeout(()=>server.closeAllConnections(),2000);timer.unref();await new Promise(resolve=>server.close(error=>{clearTimeout(timer);failure||=error;resolve();}));}
    if(failure)console.error(failure.message);
    app.exit(failure?1:0);
  })();
  return shutdownTask;
}
function openExternal(value){const safe=externalUrl(value);if(safe)shell.openExternal(safe).catch(error=>console.error('外部链接未打开：',error.message));}
function createWindow(){
  if(!serviceReady||quitRequested||shutdownTask)return Promise.resolve();
  if(window&&!window.isDestroyed())return Promise.resolve(window);
  // Dock activation and a second launch can arrive in the same event loop.
  // Share creation rather than opening duplicate editors for one archive.
  if(!windowTask)windowTask=openWindow().finally(()=>{windowTask=null;});
  return windowTask;
}
function reopenWindow(){void createWindow().catch(error=>{console.error(error);if(!qa)dialog.showErrorBox('番渡窗口暂时无法打开',error.message);});}
async function openWindow(){
  let saved;try{saved=JSON.parse(await readFile(boundsPath,'utf8'));}catch{}
  if(quitRequested||shutdownTask)return;
  const bounds=windowState(saved,screen.getAllDisplays().map(d=>d.workArea));
  window=new BrowserWindow({...bounds,minWidth:320,minHeight:480,show:false,title:'番渡',backgroundColor:'#0c111b',webPreferences:{partition:'persist:fandu-v1',sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false}});
  if(bounds.maximized)window.maximize();
  window.on('resize',()=>{clearTimeout(boundsTimer);boundsTimer=setTimeout(()=>saveBounds().catch(()=>{}),300);});
  window.on('move',()=>{clearTimeout(boundsTimer);boundsTimer=setTimeout(()=>saveBounds().catch(()=>{}),300);});
  window.on('close',()=>{saveBounds().catch(()=>{});});
  window.on('closed',()=>{window=null;if(quitRequested||process.platform!=='darwin')void shutdown();});
  window.once('ready-to-show',()=>{if(!qa)window?.show();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('will-navigate',(event,url)=>{if(!internalNavigation(url)){event.preventDefault();openExternal(url);}});
  window.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
  window.webContents.on('will-prevent-unload',event=>{
    const answer=dialog.showMessageBoxSync(window,{type:'warning',title:'仍有未完成的输入',message:'最后的输入可能尚未写入恢复记录。确定退出？',buttons:['继续编辑','仍然退出'],defaultId:0,cancelId:0,noLink:true});
    if(answer===1)event.preventDefault();else quitRequested=false;
  });
  const created=window;
  try{await created.loadURL(APP_URL);}catch(error){if(quitRequested||shutdownTask||created.isDestroyed())return;created.destroy();throw error;}
}
function setMenu(){
  const template=[];
  if(process.platform==='darwin')template.push({label:'番渡',submenu:[{role:'about',label:'关于番渡'},{type:'separator'},{role:'hide',label:'隐藏番渡'},{role:'hideOthers',label:'隐藏其他'},{role:'unhide',label:'全部显示'},{type:'separator'},{label:'退出番渡',accelerator:'Cmd+Q',click:()=>app.quit()}]});
  template.push({label:'文件',submenu:[{label:process.platform==='darwin'?'关闭窗口':'退出番渡',accelerator:process.platform==='darwin'?'Cmd+W':'Alt+F4',click:()=>process.platform==='darwin'?window?.close():app.quit()}]},
    {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
    {label:'视图',submenu:[{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'resetZoom',label:'实际大小'},{type:'separator'},{role:'togglefullscreen',label:'全屏'},...(!app.isPackaged?[{role:'toggleDevTools',label:'开发者工具'}]:[])]},
    {label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'zoom',label:'调整大小'}]});
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if(!app.requestSingleInstanceLock()){app.exit(0);}else{
  app.on('second-instance',()=>{if(quitRequested||shutdownTask)return;if(window){if(window.isMinimized())window.restore();window.show();window.focus();}else reopenWindow();});
  app.on('activate',()=>{if(!window)reopenWindow();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')void shutdown();});
  app.on('before-quit',event=>{event.preventDefault();quitRequested=true;if(window)window.close();else if(serviceReady)void shutdown();});
  app.whenReady().then(async()=>{
    if(quitRequested)return shutdown();
    await mkdir(profile,{recursive:true});
    const module=await import('../server.mjs');({atomicBytes}=await import('../lib/store.mjs'));
    server=module.makeServer({dataDir:join(profile,'data'),accessToken:token});
    server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
    const browserSession=session.fromPartition('persist:fandu-v1');
    browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    browserSession.setPermissionCheckHandler(()=>false);
    browserSession.protocol.handle('fandu',async request=>{
      const url=internalUrl(request.url);
      if(!url||(request.initiatorOrigin&&request.initiatorOrigin!=='fandu://app'))return new Response('不允许访问',{status:403});
      if(!['GET','HEAD','POST','PUT','DELETE'].includes(request.method))return new Response('不支持的请求',{status:405});
      const headers=new Headers({'X-Fandu-Desktop-Token':token,Origin:origin});
      for(const name of ['accept','content-type','x-yingjian'])if(request.headers.has(name))headers.set(name,request.headers.get(name));
      let body;
      if(!['GET','HEAD'].includes(request.method)){
        const limit=MAX_TRANSFER_BYTES+4096,reader=request.body?.getReader(),chunks=[];let size=0;
        if(reader){while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>limit){await reader.cancel();return new Response('文件过大',{status:413});}chunks.push(Buffer.from(item.value));}body=Buffer.concat(chunks);}
      }
      try{return await net.fetch(`${origin}${url.pathname}${url.search}`,{method:request.method,headers,body});}
      catch{return new Response(JSON.stringify({error:'本机服务暂不可用，请重新打开番渡。'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
    });
    browserSession.on('will-download',(event,item,contents)=>{
      if(contents!==window?.webContents){event.preventDefault();return;}
      const name=basename(item.getFilename()).replace(/[\x00-\x1f]/g,'_')||'番渡导出.json';
      item.setSaveDialogOptions({title:'导出番渡数据',defaultPath:join(app.getPath('downloads'),name)});
    });
    serviceReady=true;setMenu();if(quitRequested)await shutdown();else await createWindow();
  }).catch(async error=>{startupError=error;console.error(error);if(!qa)dialog.showErrorBox('番渡暂时无法启动',error.message);await shutdown();});
}
