import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isStageCode, usesSanityStage, drainTasks, sanityRetryDocument, isUnlimitedDrain, drainIncomplete,
  learnStage, FileSanityStageStore} from '../src/sanity';

test('a Fight with an empty stage is the sanity marker',()=>{
  assert.equal(usesSanityStage({tasks:[{type:'Fight',params:{stage:''}}]}),true);
  assert.equal(usesSanityStage({tasks:[{type:'Fight',params:{stage:'LS-6'}}]}),false);
  assert.equal(usesSanityStage({tasks:[{type:'StartUp',params:{}}]}),false);
  assert.equal(usesSanityStage({}),false);
});

test('the retry replays only the drain, with the stage named, without mutating the input',()=>{
  const doc={name:'日常',client_type:'Official',startup:true,tasks:[
    {name:'打剿',type:'Fight',params:{stage:'Annihilation',series:1}},
    {name:'返回主页',type:'Custom',params:{task_names:['ManagerReturnHome']}},
    {name:'理智作战',type:'Fight',params:{stage:'',series:0,times:2147483647}}]};
  assert.deepEqual(drainTasks(doc).map((t:any)=>t.name),['理智作战']);
  const out=sanityRetryDocument(doc,'LS-6');
  assert.deepEqual(out.tasks.map((t:any)=>t.name),['理智作战']);
  assert.equal(out.tasks[0].params.stage,'LS-6');
  assert.equal(out.tasks[0].params.times,2147483647);
  assert.equal(out.client_type,'Official');
  assert.equal(doc.tasks[2].params.stage,'');
  // An unusable stage, or a preset with nothing to replay, leaves the document alone.
  assert.equal(sanityRetryDocument(doc,''),null);
  assert.equal(sanityRetryDocument({tasks:[{type:'StartUp',params:{}}]},'LS-6'),null);
});

test('only an unlimited Fight counts as a drain, so a bounded test is never retried',()=>{
  assert.equal(isUnlimitedDrain({params:{times:2147483647}}),true);
  assert.equal(isUnlimitedDrain({params:{times:100}}),false); // R1: finite 100 is never unlimited.
  assert.equal(isUnlimitedDrain({params:{times:1}}),false);
  assert.equal(isUnlimitedDrain({params:{times:99}}),false);
  assert.equal(isUnlimitedDrain({params:{}}),false);
  assert.equal(isUnlimitedDrain(undefined),false);
});

// The fingerprint of a drain that could not spend the sanity: MAA reports success after its
// last mission, but sanity is still at least what that mission cost.
test('an incomplete drain is recognised from maa-cli output',()=>{
  const poisoned='[06:05:13 INFO ] Current sanity: 294/210\n[06:05:19 INFO ] Mission started (1 times, use 25 sanity)\n[06:21:29 INFO ] Current sanity: 269/210\n';
  const drained='[06:05:40 INFO ] Current sanity: 269/210\n[06:06:04 INFO ] Mission started (7 times, use 252 sanity)\n[06:08:17 INFO ] Current sanity: 17/210\n';
  assert.equal(drainIncomplete(poisoned),true);
  assert.equal(drainIncomplete(drained),false);
  assert.equal(drainIncomplete('recognize_drops Annihilation weekly limit reached, stop task'),true);
  assert.equal(drainIncomplete('Fight Start\nFight Completed'),false);
});

// Annihilation maps are named in CJK, so ASCII-only acceptance is what keeps one from ever
// being remembered as the sanity stage.
test('stage codes are ASCII, and annihilation names are rejected',()=>{
  for(const ok of ['LS-6','1-7','CE-6','PR-A-1','YW-7','SSReopen-IC']) assert.equal(isStageCode(ok),true,ok);
  for(const bad of ['拉特兰','切尔诺伯格','','4','LS 6','a'.repeat(30),null,undefined,42,{}]) {
    assert.equal(isStageCode(bad as any),false,String(bad));
  }
});

test('the fought stage is learned from maa-cli summary, preferring the last valid one',()=>{
  assert.equal(learnStage('[理智作战] 18:05:03 - 18:21:30 (16m 26s) Completed\nFight LS-6 5 times\ntotal drops: 初级作战记录'),'LS-6');
  assert.equal(learnStage('Fight 拉特兰 1 times, drops:'),null);
  assert.equal(learnStage('Fight 拉特兰 1 times\nFight YW-7 3 times'),'YW-7');
  assert.equal(learnStage('Fight 拉特兰 2 times\nFight 1-7 1 times'),'1-7');
  assert.equal(learnStage(''),null);
  assert.equal(learnStage('Current sanity: 269/210'),null);
});

test('the remembered stage round trips, is private, and never trusts a bad stored value',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-sanity-'));
  const file=path.join(dir,'state','sanity-stage.json');
  try {
    const store=new FileSanityStageStore(file);
    assert.deepEqual(await store.get(),{stage:null,learnedAt:null});
    await store.learn('YW-7');
    const value=await store.get();
    assert.equal(value.stage,'YW-7');
    assert.ok(value.learnedAt);
    // Windows does not implement POSIX file modes; the privacy assertion stays on POSIX hosts.
    if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
    await assert.rejects(()=>store.learn('拉特兰'),/Invalid stage code/);
    await fs.writeFile(file,'{"stage":"../etc/passwd"}\n');
    assert.equal((await store.get()).stage,null);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
