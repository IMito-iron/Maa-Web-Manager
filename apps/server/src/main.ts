import 'reflect-metadata';
import { Controller, Module, Get, Post, Put, Delete, Body, Param, Query, Res, Headers, NotFoundException, BadRequestException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express, { Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { cfg } from './config';
import { Store } from './store';
import { Engine } from './engine';
import { AdbDeviceAdapter } from './device';
import { FileSanityStageStore } from './sanity';
import { nextDate } from './domain';
import { PublicApiController, isPublicApiPath } from './public-api/http';
import { PublicApiService } from './public-api/service';
import { createPublicApiService } from './public-api/wiring';

@Controller('api')
class Api {
  constructor(private store:Store,private engine:Engine) {}
  @Get('health') health(){return {ok:true};}
  @Get('control') controlStatus(@Headers('x-control-token') token?:string){return {...this.engine.control.status(token),running:!!this.engine.current};}
  @Post('control') acquireControl(@Headers('x-control-token') token:string){return this.store.serial(async()=>this.engine.control.grant(token,!!this.engine.current));}
  @Delete('control') releaseControl(@Headers('x-control-token') token:string){return this.store.serial(async()=>this.engine.control.release(token));}
  @Post('control/heartbeat') heartbeat(@Headers('x-control-token') token:string){return this.store.serial(async()=>this.engine.control.touch(token));}
  @Post('control/screen-off') screenOff(){return this.engine.requestScreenOff();}
  @Post('control/capture-reset') captureReset(){return this.engine.requestCaptureReset();}
  @Get('status') async status(){return {...this.engine.health,accountPolicy:cfg.accountPolicy,deviceEvents:this.engine.deviceEvents,queue:await this.engine.queue(),timezone:cfg.timeZone,stageActivity:this.engine.stageActivity.status(),nextSchedule:await this.store.db.schedule.findFirst({where:{enabled:true},orderBy:{nextAt:'asc'}})};}
  @Get('devices') devices(){return this.engine.listDevices();}
  @Post('devices/select') selectDevice(@Body() b:any){return this.engine.selectDevice(b&&b.serial!=null?String(b.serial):null);}
  @Get('tasks') tasks(){return this.store.list();}
  @Get('tasks/:name') task(@Param('name') name:string){return this.store.read(name);}
  @Post('tasks') create(@Body() b:any){return this.store.save(b.name,b.raw,undefined,true);}
  @Put('tasks/:name') save(@Param('name') n:string,@Body() b:any){return this.store.save(n,b.raw,b.version);}
  @Delete('tasks/:name') remove(@Param('name') n:string,@Body() b:any){return this.store.remove(n,b.version);}
  @Post('tasks/:name/clone') async clone(@Param('name') n:string,@Body() b:any){const t=await this.store.read(n);return this.store.save(b.name,t.raw,undefined,true);}
  @Get('stages') stages(@Query('client') c?:string){return this.engine.stages(c);}
  @Post('tasks/:name/run') run(@Param('name') n:string,@Body() b:any){return this.engine.submit(n,b?.overrides);}
  @Get('queue') queue(){return this.engine.queue();}
  @Post('queue') control(@Body() b:any){return this.engine.queue(b.action);}
  @Get('runs') async history(@Query() q:any){
    const page=Math.max(1,Math.min(100000,Number(q.page)||1));
    const where:any={}; if(q.task)where.task=q.task;if(q.status)where.status=q.status;
    if(q.from||q.to){where.createdAt={};if(q.from&&!isNaN(Date.parse(q.from)))where.createdAt.gte=new Date(q.from);if(q.to&&!isNaN(Date.parse(q.to)))where.createdAt.lte=new Date(q.to);}
    const [items,total]=await Promise.all([this.store.db.run.findMany({where,orderBy:{createdAt:'desc'},skip:(page-1)*30,take:30}),this.store.db.run.count({where})]); return {items,total,page};
  }
  @Get('runs/:id') async detail(@Param('id') id:string){const r=await this.store.db.run.findUnique({where:{id}});if(!r)throw new NotFoundException();return r;}
  @Post('runs/:id/stop') stop(@Param('id') id:string){return this.engine.stop(id);}
  @Get('runs/:id/log') async log(@Param('id') id:string,@Res() res:Response){await this.detail(id);const file=this.engine.logPath(id);try{await fs.access(file);}catch{throw new NotFoundException('Log not created or expired');}res.type('text/plain').sendFile(file);}
  @Get('runs/:id/events') async logs(@Param('id') id:string,@Query('cursor') cursor:string,@Res() res:Response){
    await this.detail(id); const file=this.engine.logPath(id);
    let offset=Math.max(0,Number(res.req.headers['last-event-id']||cursor)||0),busy=false;
    this.sse(res);
    const send=async()=>{
      if(busy||res.destroyed)return;if(res.writableLength>1048576){res.end();return;}busy=true;
      try{
        const h=await fs.open(file,'r').catch(()=>null);
        if(h)try{
          const size=(await h.stat()).size;
          if(offset>size)offset=0;
          if(size>offset){const buffer=Buffer.alloc(Math.min(65536,size-offset));const {bytesRead}=await h.read(buffer,0,buffer.length,offset);offset+=bytesRead;res.write(`id: ${offset}\nevent: log\ndata: ${JSON.stringify({base64:buffer.subarray(0,bytesRead).toString('base64'),cursor:offset})}\n\n`);}
        }finally{await h.close();}
        const run=await this.detail(id);res.write(`event: status\ndata: ${JSON.stringify(run)}\n\n`);
      }catch{res.end();}finally{busy=false;}
    };
    const timer=setInterval(()=>{void send();},700);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
    res.on('close',()=>{clearInterval(timer);clearInterval(heartbeat);});await send();
  }
  @Get('events') events(@Res() res:Response){this.sse(res);let busy=false;const timer=setInterval(async()=>{if(busy||res.destroyed)return;busy=true;try{res.write(`event: status\ndata: ${JSON.stringify(await this.status())}\n\n`);}catch{res.end();}finally{busy=false;}},1000);res.on('close',()=>clearInterval(timer));}
  sse(res:Response){res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();}
  @Get('schedules') schedules(){return this.engine.schedules();}
  @Post('schedules') addSchedule(@Body() b:any){return this.engine.schedules(b);}
  /** Same rule engine that stores a schedule, so an editor preview cannot disagree with it. */
  @Post('schedules/preview') previewSchedule(@Body() b:any){
    if(!b||typeof b.type!=='string'||typeof b.expression!=='string') throw new BadRequestException('Expected type and expression');
    return {nextAt:nextDate(b.type,b.expression)};
  }
  @Put('schedules/:id') changeSchedule(@Param('id') id:string,@Body() b:any){return this.engine.schedules(b,id);}
  @Delete('schedules/:id') deleteSchedule(@Param('id') id:string){return this.store.serial(()=>this.store.db.schedule.delete({where:{id}}));}
}
@Module({controllers:[Api,PublicApiController],providers:[Store,Engine,
  {provide:'DevicePort',useFactory:()=>new AdbDeviceAdapter(cfg.deviceConfig,cfg.adb)},
  {provide:'SanityStagePort',useFactory:()=>new FileSanityStageStore(cfg.sanityState)},
  // Read-only Bot API: independent token, bounded reads, no writes of any kind.
  {provide:PublicApiService,useFactory:async(store:Store,engine:Engine)=>createPublicApiService(store,engine,process.env),inject:[Store,Engine]}]}) class AppModule{}
async function main(){
  if(!cfg.origin) throw new Error('PUBLIC_ORIGIN is required');
  const app=await NestFactory.create(AppModule,{bodyParser:false});
  // The public Bot API parses no request body and returns its own JSON errors for non-GET methods,
  // so it is exempt from the browser same-origin/JSON guard (which would otherwise answer 403).
  const jsonParser=express.json({limit:'1mb'});
  app.use((req:any,res:any,next:any)=>isPublicApiPath(req.path)?next():jsonParser(req,res,next));
  app.use((req:any,res:any,next:any)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    if(isPublicApiPath(req.path))return next();
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&& (req.headers.origin!==cfg.origin||req.headers['x-maa-request']!=='1'||!req.is('application/json'))) return res.status(403).json({message:'Same-origin JSON request required'});
    if(req.method==='OPTIONS')return res.sendStatus(403);next();
  });
  const server=app.getHttpAdapter().getInstance();
  server.use(express.static(cfg.web));server.get('/{*path}',(req:any,res:any,next:any)=>req.path.startsWith('/api/')?next():res.sendFile(path.join(cfg.web,'index.html')));
  await app.init();
  const engine=app.get(Engine);await engine.init();
  // The read-only Bot API v1 contract is fixed to Asia/Tokyo (+09:00); its day windows only line up
  // with the schedules when the Manager runs in that zone too.
  if(cfg.timeZone!=='Asia/Tokyo')console.warn(`MANAGER_TIME_ZONE=${cfg.timeZone}: Bot API v1 (/api/v1/public/*) still reports Asia/Tokyo calendar days`);
  // Same protected API on a mode-0600 socket for the bundled local CLI.
  const sock=process.env.RUNNER_SOCKET||path.join(cfg.data,'control.sock');await fs.rm(sock,{force:true});
  const local=http.createServer(server);local.listen(sock,()=>{void fs.chmod(sock,0o600);});
  if(process.env.RUNNER_SOCKET_ONLY!=='1') await app.listen(Number(process.env.PORT||3000),process.env.LISTEN_HOST||'0.0.0.0');
  let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await engine.shutdown();local.close();await app.close();process.exit(0);};
  process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
}
void main().catch(e=>{console.error(e);process.exit(1);});
