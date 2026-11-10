import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PrismaClient} from '@prisma/client';
import {AutomationRepository} from '../src/automation/repository';
import {ManagedRunnerHandler} from '../src/automation/runner-handler';
import {DeliveryWorker,RunnerPort,Submission} from '../src/automation/contracts';
import {PrismaWorkspaceRepository} from '../src/workspace/repository';
import {WorkspaceService} from '../src/workspace/service';
import {fairNext} from '../src/automation/fairness';
import {recoverExecution} from '../src/automation/recovery';

test('owner round-robin preserves FIFO within each owner',()=>{
  const time=new Date();const runs=[{id:'1',ownerId:'a',createdAt:time},{id:'2',ownerId:'a',createdAt:time},{id:'3',ownerId:'b',createdAt:time}];
  assert.equal(fairNext(runs,null)?.id,'1');assert.equal(fairNext(runs,'a')?.id,'3');assert.equal(fairNext(runs,'b')?.id,'1');
  assert.equal(fairNext([],null),undefined);
});

test('durable delivery, concurrent duplicates, cancellation tombstones, quotas and schedule recovery',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-automation-'));
  const file=path.join(dir,'db.sqlite');await fs.writeFile(file,'');
  const url='file:'+file.replaceAll('\\','/');const db=new PrismaClient({datasourceUrl:url});
  try {
    await promisify(execFile)(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy','--schema','prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url}});
    const user=await db.user.create({data:{username:'owner',passwordHash:'unused'}}),other=await db.user.create({data:{username:'other',passwordHash:'unused'}});
    const workspace=new WorkspaceService(new PrismaWorkspaceRepository(db)),repo=new AutomationRepository(db);
    const account=await workspace.createAccount(user.id,{label:'Game',matcher:'game-matcher'});
    const makeTask=(name:string)=>workspace.save(user.id,{accountId:account.id,name,settings:{stage:'1-7',times:1}});
    const task=await makeTask('first');
    const submissions=await Promise.all([repo.submit(user.id,task.id),repo.submit(user.id,task.id)]);
    assert.deepEqual(submissions.map(s=>s.status).sort(),['queued','skipped']);
    const queued=submissions.find(s=>s.status==='queued')!;
    await assert.rejects(repo.run(other.id,queued.id));await assert.rejects(repo.cancel(other.id,queued.id));
    await assert.rejects(workspace.remove(user.id,task.id,task.version),/queued/);
    const handler=new ManagedRunnerHandler(db,{status:()=>({paused:true}),stop:async()=>{},log:async()=>({base64:'',cursor:0})});
    let loseResponse=true;
    const runner:RunnerPort={
      status:async()=>({paused:true}),
      submit:async job=>{const result=await handler.handle({operation:'submit',job});if(loseResponse){loseResponse=false;throw Error('Response lost');}return result as any;},
      read:async(ownerId,id)=>handler.handle({operation:'read',ownerId,id}) as any,
      cancel:async(ownerId,id)=>handler.handle({operation:'cancel',ownerId,id}) as any,
      log:async()=>({base64:'',cursor:0}),
    };
    await new DeliveryWorker(repo,runner).tick();assert.equal((await db.managedRun.findUniqueOrThrow({where:{id:queued.id}})).delivered,false);
    // A fresh worker simulates restart after the Runner accepted but before acknowledgement.
    await new DeliveryWorker(new AutomationRepository(db),runner).tick();
    assert.equal(await db.run.count({where:{id:queued.id}}),1);
    assert.equal((await db.managedRun.findUniqueOrThrow({where:{id:queued.id}})).delivered,true);
    assert.equal(await runner.read(other.id,queued.id),null);
    await db.run.update({where:{id:queued.id},data:{status:'running',pid:123}});
    await recoverExecution(db);await new DeliveryWorker(repo,runner).tick();
    assert.equal((await repo.run(user.id,queued.id)).status,'interrupted');
    // Use a fresh submission to exercise cancellation of an acknowledged queued job.
    const queuedAgain=await repo.submit(user.id,task.id);await new DeliveryWorker(repo,runner).tick();
    await repo.cancel(user.id,queuedAgain.id);await new DeliveryWorker(repo,runner).tick();
    assert.equal((await repo.run(user.id,queuedAgain.id)).status,'cancelled');
    const late=await repo.submit(user.id,task.id);await repo.cancel(user.id,late.id);await new DeliveryWorker(repo,runner).tick();
    assert.deepEqual(await handler.handle({operation:'log',ownerId:user.id,id:late.id,cursor:0}),{base64:'',cursor:0});
    assert.equal((await runner.submit(JSON.parse(late.snapshot))).status,'cancelled');
    const changed:Submission={...JSON.parse(queued.snapshot),settings:{stage:'LS-6',times:5}};
    await assert.rejects(runner.submit(changed),/conflict/);
    await assert.rejects(runner.submit({...changed,id:'bad'}));
    await assert.rejects(runner.submit({...changed,id:randomUUID(),command:'sh'} as any),/Unsupported/);
    for(let i=0;i<5;i++)await repo.submit(user.id,(await makeTask('quota'+i)).id);
    await assert.rejects(repo.submit(user.id,(await makeTask('overflow')).id),/five/);
    await db.user.update({where:{id:user.id},data:{disabled:true}});await new DeliveryWorker(repo,runner).tick();
    assert.equal((await repo.queue(user.id)).length,0);
    await db.user.update({where:{id:user.id},data:{disabled:false}});
    const schedule=await repo.schedule(user.id,{name:'daily',taskId:task.id,type:'daily',expression:'06:00',enabled:true});
    await assert.rejects(repo.schedule(other.id,{name:'steal',taskId:task.id,type:'daily',expression:'06:00',enabled:true}));
    await assert.rejects(repo.schedule(user.id,{name:'fast',taskId:task.id,type:'cron',expression:'*/17 * * * *',enabled:true}),/ten minutes/);
    await assert.rejects(workspace.remove(user.id,task.id,task.version),/schedules/);
    const now=new Date('2026-10-12T00:00:00Z');
    await db.managedSchedule.update({where:{id:schedule.id},data:{nextAt:now}});
    await Promise.all([repo.scheduleTick(now),repo.scheduleTick(now)]);
    assert.equal(await db.managedRun.count({where:{occurrence:`${schedule.id}:${now.toISOString()}`}}),1);
    const before=await db.managedRun.count();
    await db.managedSchedule.update({where:{id:schedule.id},data:{nextAt:new Date(now.getTime()-60000)}});
    await repo.scheduleTick(now);assert.equal(await db.managedRun.count(),before);
    await db.managedSchedule.update({where:{id:schedule.id},data:{nextAt:now}});
    await repo.scheduleTick(now,true);assert.equal(await db.managedRun.count(),before);
  }finally{await db.$disconnect();await fs.rm(dir,{recursive:true,force:true});}
});
