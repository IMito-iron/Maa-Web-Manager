import {Express,Request} from 'express';
import {AutomationRepository} from './repository';
import {RunnerPort} from './contracts';
import {WorkspaceError} from '../workspace/policy';
export function installAutomationRoutes(app:Express,repo:AutomationRepository,runner:RunnerPort,sessionAlive:(req:Request)=>Promise<boolean>) {
  const submissions=new Map<string,{until:number;count:number}>();
  app.post('/api/my/tasks/:id/run',async(req,res)=>{
    const now=Date.now(),owner=res.locals.session.user.id;
    for(const [key,value] of submissions)if(value.until<=now)submissions.delete(key);
    const limit=submissions.get(owner)||{until:now+60000,count:0};
    if(++limit.count>30)throw new WorkspaceError('Submission rate limit reached',429);
    submissions.set(owner,limit);
    res.status(202).json(await repo.submit(owner,req.params.id));
  });
  app.get('/api/my/queue',async(_req,res)=>res.json({blocked:true,reason:'Account switching acceptance pending',items:await repo.queue(res.locals.session.user.id)}));
  app.get('/api/my/runs',async(req,res)=>res.json(await repo.runs(res.locals.session.user.id,Math.floor(Math.max(1,Math.min(10000,Number(req.query.page)||1))))));
  app.post('/api/my/runs/:id/stop',async(req,res)=>res.json(await repo.cancel(res.locals.session.user.id,req.params.id)));
  app.get('/api/my/runs/:id/log',async(req,res)=>{
    const owner=res.locals.session.user.id;await repo.run(owner,req.params.id);
    const cursor=Number(req.query.cursor||0);if(!Number.isSafeInteger(cursor)||cursor<0)throw new WorkspaceError('Invalid cursor');
    res.json(await runner.log(owner,req.params.id,cursor));
  });
  const streams=new Map<string,number>();
  app.get('/api/my/runs/:id/events',async(req,res)=>{
    const owner=res.locals.session.user.id;await repo.run(owner,req.params.id);
    let cursor=Number(req.headers['last-event-id']||req.query.cursor||0),busy=false;
    if(!Number.isSafeInteger(cursor)||cursor<0)throw new WorkspaceError('Invalid cursor');
    if((streams.get(owner)||0)>=2)return res.status(429).json({message:'At most two log streams per user'});
    streams.set(owner,(streams.get(owner)||0)+1);
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();
    const send=async()=>{
      if(busy||res.destroyed)return;busy=true;
      try {
        if(!await sessionAlive(req)||res.writableLength>1048576){res.end();return;}
        const run=await repo.run(owner,req.params.id);
        if(run.delivered){const log=await runner.log(owner,run.id,cursor);cursor=log.cursor;if(log.base64)res.write(`id: ${cursor}\nevent: log\ndata: ${JSON.stringify(log)}\n\n`);}
        res.write(`event: status\ndata: ${JSON.stringify({id:run.id,status:run.status,reason:run.reason})}\n\n`);
      }catch{res.end();}finally{busy=false;}
    };
    const timer=setInterval(()=>void send(),1000);
    res.on('close',()=>{clearInterval(timer);const count=(streams.get(owner)||1)-1;if(count)streams.set(owner,count);else streams.delete(owner);});
    await send();
  });
  app.get('/api/my/schedules',async(_req,res)=>res.json(await repo.schedules(res.locals.session.user.id)));
  app.post('/api/my/schedules',async(req,res)=>res.status(201).json(await repo.schedule(res.locals.session.user.id,req.body)));
  app.put('/api/my/schedules/:id',async(req,res)=>res.json(await repo.schedule(res.locals.session.user.id,req.body,req.params.id)));
  app.delete('/api/my/schedules/:id',async(req,res)=>res.json(await repo.deleteSchedule(res.locals.session.user.id,req.params.id)));
}
