// Only invoked with a temporary directory owned by migration.test.mjs.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {basename,join} from 'node:path';
const [dir,fault,operation='import']=process.argv.slice(2);
if(!['import','restore'].includes(operation))throw Error('Invalid migration operation fixture');
if(!dir || !['prepared','covers','archive','receipt','journal-sync','cover-write','archive-sync','receipt-rename'].includes(fault))throw Error('Invalid migration fault fixture');
const originalOpen=fs.promises.open,originalRename=fs.promises.rename;
const target=(path,prefix)=>basename(String(path)).startsWith(prefix+'.');
const fail=code=>Object.assign(Error(`Injected ${code}`),{code});
fs.promises.open=async function(path,...args){
  const handle=await originalOpen.call(this,path,...args);
  if(args[0]==='wx'){
    if(fault==='journal-sync' && target(path,'migration-pending.json'))handle.sync=async()=>{throw fail('EIO');};
    if(fault==='archive-sync' && target(path,'library.json'))handle.sync=async()=>{throw fail('EIO');};
    if(fault==='cover-write' && /^[a-f0-9]{64}\.png\.tmp-/.test(basename(String(path)))){
      const write=handle.writeFile.bind(handle);handle.writeFile=async()=>{await write('partial');throw fail('ENOSPC');};
    }
  }
  return handle;
};
fs.promises.rename=async function(from,to){
  if(fault==='receipt-rename' && target(from,'migration-receipts.json'))throw fail('EACCES');
  return originalRename.call(this,from,to);
};
syncBuiltinESMExports();
const {LibraryStore}=await import('../lib/store.mjs');
const {CoverCache}=await import('../lib/cover-cache.mjs');
const {MigrationCoordinator}=await import('../lib/migration.mjs');
const covers=new CoverCache(join(dir,'covers'));await covers.ready;
const coordinator=new MigrationCoordinator({dir,store:new LibraryStore(dir),covers,onStage:async stage=>{if(stage===fault)process.kill(process.pid,'SIGKILL');}});
try{
  await coordinator[operation](JSON.parse(await fs.promises.readFile(join(dir,'migration-input.json'),'utf8')));
  throw Error('Fault was not reached');
}catch(error){if(!['EIO','ENOSPC','EACCES'].includes(error.code))throw error;process.stdout.write(error.code);process.exitCode=71;}
