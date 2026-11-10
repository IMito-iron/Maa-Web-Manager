import { Injectable, Inject, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store';
import { cfg } from './config';
import { DevicePort } from './device';
import {DeviceControl} from './control';
import {executionPlan} from './execution-plan';
import {drainIncomplete, drainTasks, isUnlimitedDrain, learnStage, sanityRetryDocument} from './sanity';
import type {SanityStagePort} from './sanity';
import {recoverExecution} from './automation/recovery';
import { ACCOUNT_IDENTITY_UNVERIFIED_COMPAT, accountIdentityReason, identityPolicyNote } from './account-safety';
import { parseTask, nextDate, nameOf } from './domain';
import {compileForRun, compileReport, stageListFor} from './maa-runtime';
import {StageActivityFetcher} from './stage-activity';
import {clientOf, gameDate, mallOnceADayPlan, parseRunOverrides, type MallHistory, type RunOverridesByTask} from './maa-model';
import {CallbackLogFilter, recordMallHistory} from './mall-history';
const exec = promisify(execFile);

@Injectable()
export class Engine {
  readonly control = new DeviceControl();
  /** Activity stage data for Fight backup stages (refreshed like the Windows GUI). */
  stageActivity = new StageActivityFetcher(cfg.stageActivity, cfg.maaApiBases);
  // A screen-off request for the device supervisor: published with the control state it already
  // polls, and applied once per request (the supervisor records the timestamp it acted on).
  private screenOffAt=0;
  private captureResetAt=0;
  paused = true;
  health: any = {adb:false,android:false,display:false,maa:false,displayFps:null,checkedAt:null};
  current?: {id:string,child:ChildProcess,stopping:boolean,address:string};
  private ticking = false;
  private closing = false;
  private timer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private lastCheck=0;
  private lastPrune=0;
  private queueObservedAt=0;
  deviceEvents: any[] = [];
  private lastDeviceState = 'DISCONNECTED';
  private lastDeviceReason: string | null = null;
  constructor(public store: Store, @Inject('DevicePort') private readonly devices: DevicePort,
    @Inject('SanityStagePort') private readonly sanity: SanityStagePort) {}
  async init() {
    await this.store.init();
    await recoverExecution(this.store.db);
    // Private execution snapshots are never visible/editable through the preset API.
    const executions=path.join(cfg.data,'executions');await fs.mkdir(executions,{recursive:true,mode:0o700});
    if((await fs.lstat(executions)).isSymbolicLink())throw Error('Execution directory cannot be a symlink');
    for(const name of await fs.readdir(executions)) {
      if(/^[a-f0-9-]{36}-[01]\.json$/.test(name)) await fs.rm(path.join(executions,name),{force:true});
    }
    // Discard missed occurrences, including interval slots anchored to the previous nextAt.
    for(const s of await this.store.db.schedule.findMany()) {
      if(s.nextAt<=new Date()) await this.store.db.schedule.update({where:{id:s.id},data:{nextAt:this.advance(s,new Date())}});
    }
    this.timer=setInterval(()=>{void this.tick().catch(e=>console.error('tick:',e));},1000);
    this.syncTimer=setInterval(()=>{void this.syncControl().catch(()=>{});},1000);
    await this.probe();
  }
  // Publish the control lease state so the device-side display supervisor can
  // toggle x11vnc read-only (view mode) vs interactive (control mode).
  private async syncControl() {
    try {
      const dir='/control-state';await fs.mkdir(dir,{recursive:true,mode:0o755});
      const file=path.join(dir,'control.json');
      await fs.writeFile(file+'.tmp',JSON.stringify({held:!this.closing&&!this.current&&this.control.status().held,checkedAt:Date.now(),screenOffAt:this.screenOffAt,captureResetAt:this.captureResetAt}),{mode:0o644});
      await fs.rename(file+'.tmp',file);
    } catch {}
  }
  private logDeviceEvent(state: string, reason: string | null) {
    if (state === this.lastDeviceState && reason === this.lastDeviceReason) return;
    this.lastDeviceState = state;
    this.lastDeviceReason = reason;
    this.deviceEvents.unshift({ at: new Date().toISOString(), state, reason: reason || null });
    if (this.deviceEvents.length > 50) this.deviceEvents.length = 50;
  }
  async listDevices() { return this.devices.list(); }
  /** Stage dropdown for the editor: Windows GetStageList over the cached activity data. */
  stages(clientType?:string) { return {...stageListFor(clientType), activityData:this.stageActivity.status()}; }
  /**
   * Ask the device supervisor to darken the phone now: it drops the backlight and drives scrcpy's
   * own display power-off, so the panel goes truly dark while MAA keeps reading the screen.
   */
  requestScreenOff() {
    this.screenOffAt=Date.now();
    return {requestedAt:this.screenOffAt};
  }
  /**
   * Ask scrcpy to reset its video capture/encoding. This is the recovery for a mirror that stopped
   * producing frames; it is far cheaper than restarting the client, which leaves the stream dead.
   */
  requestCaptureReset() {
    this.captureResetAt=Date.now();
    return {requestedAt:this.captureResetAt};
  }
  async selectDevice(_serial: string | null): Promise<never> {
    throw new ConflictException('Device selection is managed by DEVICE_CONFIG; pause the queue and update the deployment configuration');
  }
  async probe() {
    const checkedAt=new Date().toISOString();
    const command=async(bin:string,args:string[])=> (await exec(bin,args,{timeout:5000,maxBuffer:65536})).stdout.trim();
    const device = await this.devices.inspect();
    const stats = await this.readDisplayStats();
    const [display,maa]=await Promise.all([
      Promise.all([fetch(cfg.display,{signal:AbortSignal.timeout(3000)}).then(r=>r.ok),Promise.resolve(stats?.connected===true&&Date.now()-stats.checkedAt<5000)]).then(values=>values.every(Boolean)).catch(()=>false),
      this.health.maa ? Promise.resolve(true) : command(cfg.maa,['version']).then(()=>true).catch(()=>false),
    ]);
    const displayFps = await this.readFps().catch(()=>null);
    const sanity = await this.sanity.get().catch(()=>({stage:null,learnedAt:null}));
    this.logDeviceEvent(device.state,device.reason);
    this.health={checkedAt,adb:device.adb,android:device.android,display:device.adb&&display,maa,displayFps:device.adb?displayFps:null,
      // Published by the display supervisor: the real capture geometry, the darkness
      // strategy that survived verification, and the USB function the phone exposes.
      displayVideo:device.adb?(stats?.video??null):null,
      displayCanvas:stats?.canvas??null,
      displayWindow:stats?.window??null,
      displayRender:stats?.render??null,
      displayDark:stats?.dark??null,adbServer:stats?.adb??null,deviceUsb:device.usb??null,deviceTransport:device.transport??null,
      sanity:{...sanity,fallback:cfg.sanityFallback},
      device:device.device,deviceState:device.state,deviceReason:device.reason};
    // The manager never opens ADB transports; the device container owns them (USB or the configured network address).
  }
  /** The supervisor's heartbeat file, read once and shared by health, video and dark state. */
  private async readDisplayStats(): Promise<any|null> {
    try { return JSON.parse(await fs.readFile('/stats/display.json','utf8')); } catch { return null; }
  }
  private async readFps(): Promise<number | null> {
    try {
      const log = await fs.readFile('/stats/scrcpy.log', 'utf8');
      const matches = log.match(/([0-9.]+)\s+fps/g);
      if (!matches || !matches.length) return null;
      const v = parseFloat(matches[matches.length - 1]);
      return Number.isFinite(v) && v >= 0 ? v : null;
    } catch { return null; }
  }
  async enqueue(task: string, source='manual', scheduleId?:string, occurrence?:string, tx:any=this.store.db, overrides?:unknown) {
    const item=await this.store.read(nameOf(task)); parseTask(item.raw);
    // Run-only options (Windows tri-state null) exist for manual runs only and are bound to this snapshot.
    let runOnly:RunOverridesByTask|null=null;
    if(overrides!==undefined&&overrides!==null) {
      if(source!=='manual') throw new BadRequestException('Run-only options are only accepted for manual runs');
      try { runOnly=parseRunOverrides(overrides,JSON.parse(item.raw)); } catch(e:any) { throw new BadRequestException(e.message); }
    }
    // Validate the compiled form (GUI tasks → Core params); dispatch compiles again with its own clock.
    const compiled=compileForRun(item.raw,task,new Date(),runOnly);
    if(compiled.errors.length) throw new BadRequestException(`任务配置无法执行：${compiled.errors.join('；')}`);
    executionPlan(JSON.stringify(compiled.document));
    const duplicate=await tx.run.findFirst({where:{task,status:{in:['queued','running']}}});
    return tx.run.create({data:{task,hash:item.version,snapshot:item.raw,overrides:runOnly?JSON.stringify(runOnly):null,status:duplicate?'skipped':'queued',source,scheduleId,occurrence,reason:duplicate?'Duplicate task already active':null,finishedAt:duplicate?new Date():null}});
  }
  async submit(task:string,overrides?:unknown) {return this.store.serial(()=>this.enqueue(task,'manual',undefined,undefined,this.store.db,overrides));}
  async queue(action?:string):Promise<{paused:boolean;observedAt:number;blocked:boolean;items:any[]}> {
    if(action) {
      if(!['pause','resume'].includes(action)) throw new BadRequestException('Expected pause or resume');
      return this.store.serial(async()=>{this.paused=action==='pause';return this.queue();});
    }
    const items=await this.store.db.run.findMany({where:{status:{in:['queued','running']}},orderBy:{createdAt:'asc'}});
    this.queueObservedAt=Math.max(Date.now(),this.queueObservedAt+1);
    return {paused:this.paused,observedAt:this.queueObservedAt,blocked:!this.health.adb||!this.health.android||!this.health.maa,items};
  }
  advance(s:{type:string,expression:string,nextAt:Date}, now:Date) {
    if(s.type==='interval') {
      const step=Number(s.expression)*60000;
      return new Date(s.nextAt.getTime()+(Math.floor((now.getTime()-s.nextAt.getTime())/step)+1)*step);
    }
    return nextDate(s.type,s.expression,now);
  }
  async tick() {
    if(this.ticking||this.closing) return; this.ticking=true;
    try {
      if(this.current && !this.current.stopping) {
        const binding=await this.devices.binding();
        if(binding.address!==this.current.address) {this.paused=true;await this.stop(this.current.id);}
      }
      if(Date.now()-this.lastCheck>10000) {this.lastCheck=Date.now(); await this.probe();}
      void this.stageActivity.maybeRefresh()?.catch(e=>console.error('stage activity:',e));
      // USB-only: stop a running task if the device disconnected mid-task.
      if(this.current&&!this.current.stopping&&(!this.health.adb||!this.health.android)) {
        await this.stop(this.current.id).catch(()=>{});
      }
      await this.store.serial(async()=>{
        const now=new Date();
        for(const s of await this.store.db.schedule.findMany({where:{enabled:true,nextAt:{lte:now}}})) {
          const nextAt=this.advance(s,now);
          await this.store.db.$transaction(async tx=>{
            // Pause and long event-loop delays skip missed occurrences, not replay them.
            if(!this.paused && now.getTime()-s.nextAt.getTime()<15000) {
              try { await this.enqueue(s.task,'schedule',s.id,`${s.id}:${s.nextAt.toISOString()}`,tx); }
              catch(e:any) {
                if(e.code==='P2002') throw e;
                await tx.run.create({data:{task:s.task,hash:'',snapshot:'',source:'schedule',scheduleId:s.id,occurrence:`${s.id}:${s.nextAt.toISOString()}`,status:'failed',reason:String(e.message).slice(0,500),finishedAt:now}});
              }
            }
            await tx.schedule.update({where:{id:s.id},data:{nextAt}});
          });
        }
        if(this.paused||this.current||this.control.held||!this.health.adb||!this.health.android||!this.health.maa) return;
        const run=await this.store.db.run.findFirst({where:{status:'queued'},orderBy:[{createdAt:'asc'},{id:'asc'}]});
        if(!run) return;
        try {
          const task=await this.store.read(run.task);
          if(task.version!==run.hash) throw new Error('Task changed after enqueue');
          await this.start(run);
        } catch(e:any) { await this.store.db.run.update({where:{id:run.id},data:{status:'failed',reason:e.message,finishedAt:new Date()}}); }
      });
      if(Date.now()-this.lastPrune>3600000) {this.lastPrune=Date.now(); await this.prune();}
    } finally {this.ticking=false;}
  }
  /** MallTask.VisitFriendsLastTime / CreditFightLastTime: the game date of the observed callback. */
  private async recordMall(callbacks:CallbackLogFilter,keys:(string|null)[],snapshot:string) {
    const date=gameDate(new Date(),clientOf(JSON.parse(snapshot)?.client_type));
    const updates:Record<string,Partial<MallHistory>>={};
    for(const marker of callbacks.markers) {
      const key=keys[marker.ordinal];
      if(key) updates[key]={...(updates[key]??{}),[marker.kind]:date};
    }
    await recordMallHistory(cfg.mallHistory,updates);
  }
  logPath(id:string) {
    if(!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('Invalid run id');
    return path.join(cfg.data,'logs',`${id}.log`);
  }
  private async start(run:any) {
    // Windows LinkStart semantics: compile every task at start; any error aborts the whole run,
    // skipped tasks (weekly schedule, no open stage, …) are left out and explained in the log.
    const compiled=compileForRun(run.snapshot,run.task,new Date(),run.overrides?JSON.parse(run.overrides):null);
    if(compiled.errors.length) throw new Error(`任务配置无法执行：${compiled.errors.join('；')}`);
    const report=compileReport(compiled);
    if(!compiled.document.tasks.length) {
      await fs.writeFile(this.logPath(run.id),report,{flag:'wx',mode:0o600});
      await this.store.db.run.update({where:{id:run.id},data:{status:'skipped',reason:'所有任务均被跳过（见日志）',finishedAt:new Date()}});
      return;
    }
    const binding=await this.devices.binding();
    if(!binding.address) throw new Error(binding.reason || 'Authorized USB device required');
    await this.devices.prepare(binding.address);
    const plan=executionPlan(JSON.stringify(compiled.document));
    const temporary:string[]=[];
    // Phase 1 of a drain uses the preset as written, so it follows the game's own 上次作战
    // entry and therefore the stage the operator is actually playing. Only the retry names a
    // stage explicitly, because by then the entry is known to be unusable.
    const retry=run.source==='sanity-retry'&&!plan.switching;
    const stageUsed=retry?((await this.sanity.get()).stage??cfg.sanityFallback):null;
    const retryDocument=retry?sanityRetryDocument(plan.documents[0],stageUsed!):null;
    if(retry&&!retryDocument) throw new Error('No safe sanity retry document');
    const documents=retry?[retryDocument]:plan.documents;
    const drains=plan.documents.some((doc:any)=>drainTasks(doc).length>0);
    const command=plan.switching?process.execPath:cfg.maa;
    // Mall once-a-day needs Core callbacks maa-cli only prints at TRACE: only such runs use -vvv,
    // and their stderr is filtered back to a -v log (see mall-history.ts).
    const mallPlan=retry?null:mallOnceADayPlan(JSON.parse(run.snapshot),compiled,run.task);
    const verbosity=mallPlan?'-vvv':'-v';
    let args:string[];
    // Every run hands maa-cli private snapshot files: the stored preset carries the Manager's GUI
    // section and pre-compile params, and may differ from what was compiled for this run.
    {
      try {
        for(let i=0;i<documents.length;i++) {
          const file=path.join(cfg.data,'executions',`${run.id}-${i}.json`);
          await fs.writeFile(file,JSON.stringify(documents[i]),{flag:'wx',mode:0o600});
          temporary.push(file);
        }
      } catch(e) {await Promise.all(temporary.map(file=>fs.rm(file,{force:true})));throw e;}
      args=plan.switching
        ?[path.join(__dirname,'sequence-main.js'),cfg.maa,binding.address,...temporary]
        :['run',temporary[0],'--addr',binding.address,'--batch',verbosity];
    }
    if(stageUsed!==null) console.error(`Sanity drain stage: ${stageUsed} (run ${run.id})`);
    const file=await fs.open(this.logPath(run.id),'wx',0o600);
    try { await file.write(report); } catch(e) {await file.close(); await Promise.all(temporary.map(file=>fs.rm(file,{force:true}))); throw e;}
    let child:ChildProcess;
    try { child=spawn(command,args,{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MAA_MANAGER_VERBOSITY:verbosity}}); }
    catch(e) {await file.close(); await Promise.all(temporary.map(file=>fs.rm(file,{force:true}))); throw e;}
    this.current={id:run.id,child,stopping:false,address:binding.address};
    let bytes=Buffer.byteLength(report), truncated=false, spawnError='', writeError='';
    let writing=Promise.resolve();
    const append=(chunk:Buffer)=>{
      if(truncated) return;
      let output=chunk;
      if(bytes+chunk.length>cfg.logLimit) {output=Buffer.concat([chunk.subarray(0,Math.max(0,cfg.logLimit-bytes)),Buffer.from('\n[Log limit reached; further output discarded]\n')]); truncated=true;}
      bytes+=output.length;
      writing=writing.then(async()=>{await file.write(output);}).catch(e=>{writeError=String(e.message); this.paused=true; this.signal(child,'SIGTERM');});
      // Apply backpressure to bound queued memory while retaining both output streams.
      child.stdout?.pause(); child.stderr?.pause();
      void writing.finally(()=>{child.stdout?.resume(); child.stderr?.resume();});
    };
    const callbacks=mallPlan?new CallbackLogFilter():null;
    child.stdout!.on('data',append);
    child.stderr!.on('data',(chunk:Buffer)=>{ if(!callbacks) return append(chunk); const kept=callbacks.feed(chunk); if(kept) append(Buffer.from(kept)); });
    child.on('error',e=>{spawnError=e.message;});
    const recorded=this.store.db.run.update({where:{id:run.id},data:{status:'running',pid:child.pid??null,startedAt:new Date()}});
    child.on('close',(code,signal)=>{
      void (async()=>{
        if(callbacks){const rest=callbacks.flush(); if(rest) append(Buffer.from(rest));}
        await recorded; await writing; await file.close();
        if(callbacks&&mallPlan) await this.recordMall(callbacks,mallPlan.keys,run.snapshot).catch(e=>console.error('mall history:',e));
        await Promise.all(temporary.map(file=>fs.rm(file,{force:true})));
        // Ensure descendants cannot outlive the CLI leader.
        this.signal(child,'SIGKILL');
        const cancelled=this.current?.id===run.id&&this.current?.stopping;
        const status=this.closing?'interrupted':cancelled?'cancelled':code===0&&!writeError&&!spawnError?'success':'failed';
        const failure=writeError||spawnError||(signal?`Signal ${signal}`:null);
        // One bounded read of this run's own log feeds the reason, the learning and the retry.
        const tail=await this.readLogTail(run.id);
        const diagnosis=await this.diagnose(status,binding.address,tail);
        // A switching run that stopped at the identity gate is not an ordinary MAA failure: the
        // stable code lets the UI/API say "account unverified" instead of guessing from exit codes.
        const identity=accountIdentityReason(plan.switching,code);
        // Explicit compatibility mode: only the sequence knows whether identity was unverifiable, and
        // it says so in this run's log. A confirmed run carries no risk note under any policy.
        const compatibility=plan.switching&&plan.account.identityRequired&&status==='success'
          &&(await this.readLogTail(run.id,cfg.logLimit)).includes(ACCOUNT_IDENTITY_UNVERIFIED_COMPAT)
          ?identityPolicyNote(cfg.accountPolicy):null;
        const notes=[identity,compatibility,failure,diagnosis].filter((value):value is string=>!!value);
        await this.store.db.run.update({where:{id:run.id},data:{status,exitCode:code,pid:null,finishedAt:new Date(),reason:notes.length?notes.join(' '):null}});
        if(this.current?.id===run.id) this.current=undefined;
        if(!failure&&!this.closing) {
          await this.learnSanityStage(status,drains,tail);
          await this.retryDrainIfIncomplete(run,plan,status,tail);
        }
      })().catch(e=>{this.paused=true;console.error('finalize:',e);});
    });
    try {await recorded;} catch(e) {this.signal(child,'SIGKILL'); throw e;}
  }
  /** Bounded read of a run's own log tail; shared by the reason, the learning and the retry. */
  private async readLogTail(id:string,limit=262144):Promise<string> {
    try {
      const handle=await fs.open(this.logPath(id),'r');
      try {
        const size=(await handle.stat()).size;
        const length=Math.min(limit,size);
        const buffer=Buffer.alloc(length);
        await handle.read(buffer,0,length,size-length);
        return buffer.toString('utf8');
      } finally {await handle.close();}
    } catch {return '';}
  }
  /**
   * Bounded log forensics: a run that failed because an administrative screen was left in the
   * foreground looks exactly like a game-side failure, and a drain that could not spend the
   * sanity still exits zero. Both become a legible reason.
   */
  private async diagnose(status:string,address:string|null,tail:string):Promise<string|null> {
    const notes:string[]=[];
    if(status==='success'&&drainIncomplete(tail)) {
      notes.push('理智未耗尽：按游戏「上次作战」的关卡没有用尽理智（该记忆会被剿灭作战改写）；只有满足安全重试条件时，管理器才会用记住的关卡自动重试一次。');
    }
    const foregroundOf=this.devices.foreground?.bind(this.devices);
    if(status!=='success'&&address&&foregroundOf) {
      const foreground=await foregroundOf(address).catch(()=>null);
      if(foreground) notes.push(`失败时前台应用：${foreground}`);
    }
    return notes.length?notes.join(' '):null;
  }
  /**
   * Remembers the stage a drain actually fought, so a poisoned 上次作战 entry can still be
   * drained later. Never learned from a run that failed to spend the sanity: the name MAA
   * reports in that case is the annihilation map, which must not become the fallback stage.
   */
  private async learnSanityStage(status:string,drains:boolean,tail:string):Promise<void> {
    if(!drains||status!=='success'||drainIncomplete(tail)) return;
    const stage=learnStage(tail);
    if(stage&&stage!==(await this.sanity.get()).stage) {
      await this.sanity.learn(stage);
      console.error(`Sanity stage remembered: ${stage}`);
    }
  }
  /**
   * Phase two of a drain. When the game's 上次作战 entry led somewhere that did not spend the
   * sanity — the annihilation map, or a stage that no longer exists — queue exactly one retry
   * that names the remembered stage, replaying only the drain rather than the whole preset.
   */
  private async retryDrainIfIncomplete(run:any,plan:any,status:string,tail:string):Promise<void> {
    if(status!=='success'||run.source==='sanity-retry'||plan.switching) return;
    if(!plan.documents.some((doc:any)=>drainTasks(doc).some(isUnlimitedDrain))) return;
    if(!drainIncomplete(tail)) return;
    const stage=(await this.sanity.get()).stage??cfg.sanityFallback;
    if(!plan.documents.some((doc:any)=>sanityRetryDocument(doc,stage))) return;
    let queued=false;
    await this.store.serial(async()=>{
      if(await this.store.db.run.findFirst({where:{task:run.task,status:{in:['queued','running']}}})) return;
      await this.store.db.run.create({data:{task:run.task,hash:run.hash,snapshot:run.snapshot,status:'queued',
        source:'sanity-retry',reason:`理智未耗尽：已用 ${stage} 重试一次（按游戏上次作战的关卡未能用尽理智）`}});
      queued=true;
    });
    if(queued) console.error(`Sanity retry queued for ${run.task} on ${stage}`);
  }
  signal(child:ChildProcess,signal:NodeJS.Signals) { if(child.pid) try {process.kill(-child.pid,signal);} catch(e:any) {if(e.code!=='ESRCH') console.error(e);} }
  async stop(id:string) {
    return this.store.serial(async()=>{
      const run=await this.store.db.run.findUnique({where:{id}}); if(!run) throw new NotFoundException();
      if(run.status==='queued') return this.store.db.run.update({where:{id},data:{status:'cancelled',finishedAt:new Date(),reason:'Cancelled before execution'}});
      if(this.current?.id!==id) throw new ConflictException('Run is not active');
      const active=this.current; active.stopping=true; this.signal(active.child,'SIGTERM');
      const timer=setTimeout(()=>{if(this.current===active) this.signal(active.child,'SIGKILL');},10000); timer.unref();
      return {ok:true};
    });
  }
  async schedules(body?:any,id?:string) {
    if(!body) return this.store.db.schedule.findMany({orderBy:{nextAt:'asc'}});
    return this.store.serial(async()=>{
      if(typeof body.name!=='string'||!body.name.trim()||body.name.length>120||typeof body.expression!=='string'||body.expression.length>100||typeof body.enabled!=='boolean') throw new BadRequestException('Invalid schedule');
      await this.store.read(nameOf(body.task));
      const data={name:body.name,task:body.task,type:body.type,expression:body.expression,enabled:body.enabled,nextAt:nextDate(body.type,body.expression)};
      return id?this.store.db.schedule.update({where:{id},data}):this.store.db.schedule.create({data});
    });
  }
  async prune() {
    const cutoff=new Date(Date.now()-cfg.retention*86400000);
    for(const run of await this.store.db.run.findMany({where:{finishedAt:{lt:cutoff}}})) await fs.rm(this.logPath(run.id),{force:true});
  }
  async shutdown() {
    this.closing=true;this.paused=true;clearInterval(this.timer);clearInterval(this.syncTimer);
    await this.syncControl();
    const active=this.current;
    if(active) {
      this.signal(active.child,'SIGTERM');
      const until=Date.now()+10000; while(this.current&&Date.now()<until) await new Promise(r=>setTimeout(r,100));
      if(this.current) this.signal(active.child,'SIGKILL');
      const final=Date.now()+2000; while(this.current&&Date.now()<final) await new Promise(r=>setTimeout(r,100));
    }
    await this.store.db.$disconnect();
  }
}
