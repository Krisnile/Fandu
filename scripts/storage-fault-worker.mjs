// Runs only against the temporary archive provided by test/storage-faults.test.mjs.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const [dir, operation, fault] = process.argv.slice(2);
if (!dir || !['save', 'save-receipt', 'save-receipt-confirm','save-receipt-replay','restore', 'add', 'draft', 'draft-rotate','draft-upgrade'].includes(operation) || !['write', 'sync', 'rename', 'directory-sync', 'crash-before', 'crash-after'].includes(fault)) throw Error('Invalid fault fixture');
const originalOpen = fs.promises.open;
const originalRename = fs.promises.rename;
const isTarget = path => (operation.startsWith('draft')?/^entry-drafts\.json\..+\.tmp$/:/^library\.json\..+\.tmp$/).test(basename(String(path)));
const failure = code => Object.assign(Error(`Injected ${code}`), {code});
let mainRenamed=['save-receipt-confirm','save-receipt-replay'].includes(operation);
fs.promises.open = async function(path, ...args) {
  const handle = await originalOpen.call(this, path, ...args);
  if (isTarget(path) && args[0] === 'wx') {
    if (fault === 'write') {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => { await write('{"partial":'); throw failure('ENOSPC'); };
    }
    if (fault === 'sync') handle.sync = async () => { throw failure('EIO'); };
  }
  if (fault === 'directory-sync' && mainRenamed && String(path) === dir && args[0] === 'r') handle.sync=async()=>{throw failure('EIO');};
  return handle;
};
fs.promises.rename = async function(from, to) {
  if (isTarget(from)) {
    if (fault === 'rename') throw failure('EACCES');
    if (fault === 'crash-before') process.kill(process.pid, 'SIGKILL');
  }
  const result = await originalRename.call(this, from, to);
  if (isTarget(from)) mainRenamed=true;
  if (isTarget(from) && fault === 'crash-after') process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
const {LibraryStore} = await import('../lib/store.mjs');
const store = new LibraryStore(dir);
try {
  if (operation === 'save') {
    const current = await store.read();
    await store.save({...current, entries:current.entries.map(x => ({...x, note:'new draft'}))});
  } else if(operation === 'add') {
    await store.addEntry(JSON.parse(await fs.promises.readFile(`${dir}/add-request.json`,'utf8')));
  } else if(operation==='save-receipt'){
    await store.saveWithReceipt(JSON.parse(await fs.promises.readFile(`${dir}/save-request.json`,'utf8')));
  } else if(operation==='save-receipt-confirm'||operation==='save-receipt-replay'){
    const payload=JSON.parse(await fs.promises.readFile(`${dir}/save-request.json`,'utf8'));
    if(operation==='save-receipt-confirm')await store.saveStatus(payload.requestId);
    else await store.saveWithReceipt(payload);
  } else if(operation.startsWith('draft')) {
    const {EntryDraftStore}=await import('../lib/drafts.mjs');
    const drafts=new EntryDraftStore(dir,store);
    if(operation==='draft-upgrade')await drafts.allocate();
    else if(operation==='draft-rotate')await drafts.remove(JSON.parse(await fs.promises.readFile(`${dir}/draft-request.json`,'utf8')));
    else await drafts.save(JSON.parse(await fs.promises.readFile(`${dir}/draft-request.json`,'utf8')));
  } else {
    const catalog = await store.listBackups();
    const selected = catalog.backups.find(x => x.id === 'backup-1.json');
    await store.restore({id:selected.id, token:selected.token, currentToken:catalog.current.token});
  }
  throw Error('Fault was not reached');
} catch (e) {
  if (!['ENOSPC', 'EIO', 'EACCES'].includes(e.code)) throw e;
  process.stdout.write(e.code);
  process.exitCode = 71;
}
