import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotices} from '../src/notices.js';

function harness(options={}){
  let time=0,sequence=0;const timers=new Map(),announcements=[];
  const notices=createNotices({...options,now:()=>time,schedule:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:time+delay});return id;},cancel:id=>timers.delete(id),announce:value=>announcements.push(value)});
  const advance=duration=>{const end=time+duration;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;time=next[1].at;timers.delete(next[0]);next[1].fn();}time=end;};
  return {notices,advance,timers,announcements};
}
test('plain and actionable notices expire after usable time, not total wall time',()=>{
  const {notices:n,advance}=harness();n.add('已保存');n.add('已移出',{label:'撤销',run:()=>true});advance(5499);assert.equal(n.snapshot().length,2);advance(1);assert.equal(n.snapshot().length,1);advance(6500);assert.equal(n.snapshot().length,0);
});
test('hover, background, focus, overflow and operation locks compose without resetting remaining time',()=>{
  const {notices:n,advance}=harness();const id=n.add('已移出',{label:'撤销',run:()=>true});advance(10000);
  n.pause('hover',true);n.pause('background',true);n.focus(id);n.block(true);n.pause('overflow',true);advance(60000);
  n.pause('hover',false);n.pause('background',false);n.focus(null);n.block(false);advance(60000);assert.equal(n.snapshot().length,1);
  n.pause('overflow',false);advance(1999);assert.equal(n.snapshot().length,1);advance(1);assert.equal(n.snapshot().length,0);
});
test('blocked actions cannot start and unlocking resumes them',async()=>{
  const {notices:n}=harness();let runs=0;const id=n.add('已移出',{label:'撤销',run:()=>{runs++;}});n.block(true);assert.equal(await n.run(id),false);assert.equal(runs,0);n.block(false);assert.equal(await n.run(id),true);assert.equal(runs,1);assert.equal(n.snapshot().length,0);
});
test('notices with the same deadline expire together',()=>{
  const {notices:n,advance}=harness();n.add('第一条',{label:'撤销',run:()=>true});n.add('第二条',{label:'撤销',run:()=>true});advance(12000);assert.deepEqual(n.snapshot(),[]);
});
test('in-flight actions are single-flight, non-dismissible and cannot be evicted',async()=>{
  const {notices:n,advance}=harness({limit:2});let release;const gate=new Promise(resolve=>release=resolve),id=n.add('已移出',{label:'撤销',run:()=>gate});const work=n.run(id);advance(60000);assert.equal(n.dismiss(id),false);assert.equal(await n.run(id),false);n.add('第一次保存');n.add('第二次保存');assert.equal(n.snapshot()[0].id,id);release();assert.equal(await work,true);assert.deepEqual(n.snapshot().map(item=>item.message),['第二次保存']);
});
test('errors and false results stay in the original notice for a fresh retry',async()=>{
  const {notices:n,advance,announcements}=harness();let attempt=0;const id=n.add('已移出',{label:'撤销',run:()=>{if(++attempt===1)throw Error('磁盘暂不可用');if(attempt===2)return false;return true;}});
  assert.equal(await n.run(id),false);assert.equal(n.snapshot()[0].error,'磁盘暂不可用');advance(11000);assert.equal(await n.run(id),false);assert.equal(n.snapshot()[0].error,'操作未完成，请重试');advance(11000);assert.equal(n.snapshot()[0].id,id);assert.equal(await n.run(id),true);assert.equal(n.snapshot().length,0);assert.deepEqual(announcements,['已移出','磁盘暂不可用','操作未完成，请重试']);
});
test('message coalescing preserves identity and renews only its own lifetime',()=>{
  const {notices:n,advance,announcements}=harness();const id=n.add('已保存');n.add('已移出',{label:'撤销',run:()=>true});advance(5000);assert.equal(n.add('已保存'),id);assert.equal(n.snapshot().length,2);advance(5500);assert.deepEqual(n.snapshot().map(item=>item.message),['已移出']);advance(1500);assert.equal(n.snapshot().length,0);assert.deepEqual(announcements,['已保存','已移出']);
});
test('obsolete actions explain the conflict without offering an ineffective retry',async()=>{
  const {notices:n}=harness();let runs=0;const id=n.add('从头重看',{label:'撤销',run:()=>{runs++;throw Object.assign(Error('已有新的进度'),{retryable:false});}});assert.equal(await n.run(id),false);assert.equal(n.snapshot()[0].unavailable,true);assert.equal(n.snapshot()[0].error,'已有新的进度');assert.equal(await n.run(id),false);assert.equal(runs,1);assert.equal(n.dismiss(id),true);
});
test('persistent recovery cannot expire or be dismissed and remains usable while other actions are blocked',async()=>{
  const {notices:n,advance}=harness({limit:1});let release;const gate=new Promise(resolve=>release=resolve),busy=n.add('撤销等待',{label:'撤销',run:()=>gate});const waiting=n.run(busy);
  n.block(true);const recovery=n.add('保存待核对',{label:'核对保存',persistent:true,allowWhileBlocked:true,run:()=>true});assert.ok(recovery);advance(60000);assert.equal(n.dismiss(recovery),false);assert.equal(n.snapshot().find(item=>item.id===recovery).blocked,false);assert.equal(await n.run(recovery),true);release();await waiting;assert.deepEqual(n.snapshot(),[]);
});
test('bounded stack evicts ordinary messages first and retains keyboard focus',()=>{
  const {notices:n}=harness({limit:2});const focused=n.add('旧撤销',{label:'撤销',run:()=>true});n.focus(focused);n.add('普通提示');n.add('新撤销',{label:'撤销',run:()=>true});assert.deepEqual(n.snapshot().map(item=>item.message),['旧撤销','新撤销']);n.add('另一条提示');assert.equal(n.snapshot()[0].id,focused);assert.equal(n.snapshot().length,2);
});
test('destroy releases timers and ignores late action completion or errors',async()=>{
  for(const reject of [false,true]){const {notices:n,timers,announcements,advance}=harness();let release;const gate=new Promise(resolve=>release=resolve);const id=n.add('正在撤销',{label:'撤销',run:async()=>{await gate;if(reject)throw Error('late');}});const work=n.run(id);n.add('已保存');n.destroy();assert.equal(timers.size,0);advance(60000);release();assert.equal(await work,false);assert.equal(n.add('later'),undefined);assert.deepEqual(n.snapshot(),[]);assert.deepEqual(announcements,['正在撤销','已保存']);}
});
