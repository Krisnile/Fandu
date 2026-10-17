import {test} from 'node:test';
import assert from 'node:assert/strict';
import {internalUrl,internalNavigation,externalUrl,windowState} from '../desktop/policy.mjs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {makeServer} from '../server.mjs';
test('desktop navigation and link policy keep remote pages out of privileged window',()=>{
  assert.equal(internalNavigation('fandu://app/#library'),true);
  for(const url of ['fandu://app.evil/','fandu://user@app/','fandu://app:4/','file:///tmp/index.html','https://example.org/','fandu://app/api/library'])assert.equal(internalNavigation(url),false,url);
  assert.ok(internalUrl('fandu://app/api/library'));
  for(const url of ['javascript:alert(1)','http://example.org','https://127.0.0.1','https://[::1]/','https://user:pass@example.org','https://app.local/'])assert.equal(externalUrl(url),null);
  assert.equal(externalUrl('https://www.wikipedia.org/'),'https://www.wikipedia.org/');
});
test('removed monitors and corrupted preferences do not strand the window',()=>{
  const areas=[{x:0,y:0,width:1280,height:800}];
  assert.deepEqual(windowState(null,areas),{width:1280,height:850});
  assert.equal(windowState({x:4000,y:0,width:1000,height:700},areas).x,undefined);
  assert.deepEqual(windowState({x:10,y:20,width:20,height:40,maximized:true},areas),{x:10,y:20,width:320,height:480,maximized:true});
});
test('private desktop service rejects direct loopback access including static files',async()=>{
  const server=makeServer({dataDir:await mkdtemp(join(tmpdir(),'fandu-private-service-')),accessToken:'private-test-token'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base)).status,403);
    assert.equal((await fetch(`${base}/api/library`,{headers:{'X-Yingjian':'1'}})).status,403);
    assert.equal((await fetch(`${base}/api/library`,{headers:{'X-Yingjian':'1','X-Fandu-Desktop-Token':'private-test-token'}})).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
