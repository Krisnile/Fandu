import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../server.mjs';
const dataDir = process.argv[2] || await mkdtemp(join(tmpdir(),'yingjian-browser-qa-'));
const server = makeServer({dataDir});
server.listen(4174,'127.0.0.1',()=>console.log(`QA: http://127.0.0.1:4174 · isolated data: ${dataDir}`));
