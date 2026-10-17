// Isolated browser fixture: never uses the user's data directory.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LibraryStore } from '../lib/store.mjs';
import { entry } from '../src/model.js';
import { makeServer } from '../server.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'yingjian-recovery-browser-'));
const store = new LibraryStore(dataDir);
const a = entry({id:'qa-recovery-a',title:'恢复验收 A',type:'anime',note:'备份中的笔记',progress:3,total:12});
const b = entry({id:'qa-recovery-b',title:'恢复验收 B',type:'movie'});
await store.save({revision:0,entries:[a],settings:{columns:4,theme:'cyan'}});
await store.save({revision:1,entries:[a,b],settings:{columns:4,theme:'cyan'}});
await store.save({revision:2,entries:[{...a,note:'最新笔记'},b]});
await writeFile(join(dataDir,'library.json'),'{interrupted-write');
const server = makeServer({dataDir});
server.listen(4175,'127.0.0.1',()=>console.log(`Recovery QA: http://127.0.0.1:4175 · ${dataDir}`));
