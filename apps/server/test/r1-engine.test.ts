import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../src/engine';
import {Store} from '../src/store';
import {cfg} from '../src/config';
import {nextDate} from '../src/domain';
import {executionPlan} from '../src/execution-plan';
const max=2147483647;
const raw=JSON.stringify({startup:true,tasks:[{type:'Fight',params:{stage:'',times:1}},{type:'Fight',params:{stage:'',times:max,medicine:0,stone:0}}]});
const tail='Annihilation weekly limit reached';
test('A10 Fake Engine queues once after partial success, never failure/cancel/retry/switch/duplicate',async()=>{
 for(const scenario of ['success','failed','cancelled','interrupted','retry','switch','duplicate','complete','bad-stage']){
  const created:any[]=[];
  const store:any={serial:async(f:any)=>f(),db:{run:{findFirst:async()=>scenario==='duplicate'?{}:null,create:async(v:any)=>created.push(v.data)}}};
  const engine:any=new Engine(store,{} as any,{get:async()=>({stage:scenario==='bad-stage'?'../bad':'YW-7',learnedAt:null}),learn:async()=>{throw Error('unexpected learn')}});
  const plan=executionPlan(raw);if(scenario==='switch')plan.switching=true;
  await engine.retryDrainIfIncomplete({task:'fixture',hash:'synthetic',snapshot:raw,source:scenario==='retry'?'sanity-retry':'manual'},plan,['failed','cancelled','interrupted'].includes(scenario)?scenario:'success',scenario==='complete'?'Current sanity: 0/210':tail);
  assert.equal(created.length,scenario==='success'?1:0,scenario);
  if(created.length){assert.equal(created[0].source,'sanity-retry');assert.equal(created[0].snapshot,raw);
   await engine.retryDrainIfIncomplete({...created[0]},plan,'success',tail);assert.equal(created.length,1,'retry cannot recurse even when retry incomplete');}
 }
});
test('A02/A09 Store preserves exact expiry JSON, versions and conflicts in an isolated fake database',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'maa-r1-store-')),previous=cfg.tasks;cfg.tasks=directory;
 const store=new Store();(store as any).db={run:{count:async()=>0},schedule:{count:async()=>0}};
 try{
  const first=JSON.stringify({future:{flag:false},tasks:[{type:'Fight',params:{medicine_expire_days:0,expiring_medicine:5,stone:0,unknown:'keep'}}]});
  const saved=await store.save('fixture',first,undefined,true);assert.equal(saved.raw,first);
  const update=first.replace('"keep"','"still-keep"');const newer=await store.save('fixture',update,saved.version);assert.equal(newer.raw,update);assert.notEqual(newer.version,saved.version);
  await assert.rejects(()=>store.save('fixture',first,saved.version),/Configuration changed/);assert.equal((await store.read('fixture')).raw,update);
 }finally{cfg.tasks=previous;await fs.rm(directory,{recursive:true,force:true});}
});
test('A17 backend rejects empty/invalid weekly days, keeps daily/cron/valid weeks',()=>{
 for(const expression of ['', ' 06:00','1, 06:00','1,9 06:00','7 06:00'])assert.throws(()=>nextDate('weekly',expression));
 for(const [type,expression] of [['weekly','1 06:00'],['weekly','0,1,2,3,4,5,6 06:00'],['daily','06:00'],['cron','0 6 * * *'],['interval','60']])assert(nextDate(type,expression,new Date('2026-10-27T00:00:00Z'))>new Date('2026-10-27T00:00:00Z'));
});

test('A10 Fake executor records original tasks unchanged and retry sends only the approved Fight',async()=>{
 const {sanityRetryDocument}=await import('../src/sanity');
 const original=JSON.stringify({name:'fixture',client_type:'Official',startup:true,closedown:true,tasks:[
  {type:'StartUp',params:{account_name:'',future_flag:false}},
  {type:'Fight',params:{stage:'CE-6',times:1,medicine:0,stone:0}},
  {type:'Fight',params:{stage:'',times:max,medicine:0,stone:0,medicine_expire_days:0,series:0,report_to_penguin:false}},
  {type:'Award',params:{award:true}}]});
 const calls:any[]=[];
 const fakeExecutor={execute:async(document:any)=>calls.push(JSON.parse(JSON.stringify(document)))};
 const plan=executionPlan(original);
 for(const document of plan.documents)await fakeExecutor.execute(document);
 assert.deepEqual(calls[0],JSON.parse(original),'initial config including unrelated tasks is byte-value equivalent');
 const retry=sanityRetryDocument(plan.documents[0],'YW-7');await fakeExecutor.execute(retry);
 assert.equal(calls.length,2);assert.deepEqual(calls[1].tasks,[{type:'Fight',params:{...JSON.parse(original).tasks[2].params,stage:'YW-7'}}]);
 assert.equal(calls[1].startup,false);assert.equal(calls[1].closedown,false);
 assert.equal(calls[1].tasks[0].params.medicine,0);assert.equal(calls[1].tasks[0].params.stone,0);assert.equal(calls[1].tasks[0].params.medicine_expire_days,0);
 assert.equal(original,JSON.stringify(JSON.parse(original)));
});

test('A10 actual Engine.start hands Fake Node child the private retry document and stops after retry failure',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'maa-r1-child-'));
 const previous={data:cfg.data,tasks:cfg.tasks,maa:cfg.maa},oldOptions=process.env.NODE_OPTIONS;
 const preload=path.join(directory,'fake-preload.cjs'),capture=path.join(directory,'capture.json');
 cfg.data=directory;cfg.tasks=path.join(directory,'tasks');cfg.maa=process.execPath;
 await Promise.all(['logs','executions','tasks'].map(name=>fs.mkdir(path.join(directory,name))));
 await fs.writeFile(preload,`const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(1);const file=a[1].endsWith('.json')?a[1]:path.join(${JSON.stringify(cfg.tasks)},a[1]+'.json');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:a,document:JSON.parse(fs.readFileSync(file,'utf8'))}));console.log('Annihilation weekly limit reached');process.exit(Number(process.env.R1_FAKE_EXIT||0));`);
 process.env.NODE_OPTIONS='--require='+JSON.stringify(preload);
 const created:any[]=[],updates:any[]=[],deviceCalls:string[]=[];
 const store:any={serial:async(f:any)=>f(),db:{run:{update:async(v:any)=>updates.push(v.data),findFirst:async()=>null,create:async(v:any)=>created.push(v.data)}}};
 const engine:any=new Engine(store,{binding:async()=>({address:'FAKE-USB'}),prepare:async(address:string)=>deviceCalls.push(address)} as any,{get:async()=>({stage:'YW-7',learnedAt:null}),learn:async()=>{throw Error('unexpected learning')}});
 engine.signal=()=>{}; // Windows has no POSIX groups; no subprocess descendants are created.
 const awaitFinish=async()=>{for(let i=0;i<200;i++){if(!engine.current)return;await new Promise(r=>setTimeout(r,10));}throw Error('Fake child did not finalize');};
 try{
  await fs.writeFile(path.join(cfg.tasks,'fixture.json'),raw);
  await engine.start({id:'00000000-0000-4000-8000-000000000001',task:'fixture',hash:'synthetic',snapshot:raw,source:'manual'});await awaitFinish();
  assert.deepEqual(JSON.parse(await fs.readFile(capture,'utf8')).document,JSON.parse(raw));
  assert.equal(created.length,1);assert.equal(created[0].source,'sanity-retry');
  process.env.R1_FAKE_EXIT='1';
  await engine.start({...created[0],id:'00000000-0000-4000-8000-000000000002'});await awaitFinish();
  const final=JSON.parse(await fs.readFile(capture,'utf8'));
  assert.equal(final.argv[0],path.resolve('run')); // Node resolves its synthetic main argv to an absolute path.
  assert.equal(path.dirname(final.argv[1]),path.join(directory,'executions'));assert.equal(path.extname(final.argv[1]),'.json');
  assert.deepEqual(final.argv.slice(2),['--addr','FAKE-USB','--batch','-v']);
  assert.deepEqual(final.document.tasks,[{type:'Fight',params:{stage:'YW-7',times:max,medicine:0,stone:0}}]);
  assert.equal(final.document.startup,false);assert.equal(final.document.closedown,false);
  assert.equal(created.length,1,'failed retry never queues another run');assert(updates.some(v=>v.status==='failed'));
  assert.deepEqual(await fs.readdir(path.join(directory,'executions')),[]);assert.deepEqual(deviceCalls,['FAKE-USB','FAKE-USB']);
 }finally{
  Object.assign(cfg,previous);if(oldOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=oldOptions;delete process.env.R1_FAKE_EXIT;
  await fs.rm(directory,{recursive:true,force:true});
 }
});
