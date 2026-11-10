import {serialTransaction} from '../transaction';
import {PrismaClient,Prisma} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import {DeliveryRepository,RunnerState,Submission} from './contracts';
import {WorkspaceError,label,fightTask} from '../workspace/policy';
import {nextDate} from '../domain';
import {scheduleTimeZone} from '../time-zone';
import {CronExpressionParser} from 'cron-parser';

const active=['queued','running'];
export class AutomationRepository implements DeliveryRepository {
  constructor(private db:PrismaClient) {}
  async ownerEnabled(ownerId:string){return !!await this.db.user.findFirst({where:{id:ownerId,disabled:false}});}
  async submit(ownerId:string,taskId:string,source='manual',occurrence?:string,tx?:Prisma.TransactionClient):Promise<any> {
    if(!tx)return serialTransaction(this.db,t=>this.submit(ownerId,taskId,source,occurrence,t));
    const task=await tx.managedTask.findFirst({where:{id:taskId,ownerId},include:{account:true}});
    if(!task||task.account.ownerId!==ownerId)throw new WorkspaceError('Task not found',404);
    if(!await tx.user.findFirst({where:{id:ownerId,disabled:false}}))throw new WorkspaceError('User disabled',403);
    if(occurrence){const prior=await tx.managedRun.findUnique({where:{occurrence}});if(prior)return prior;}
    const duplicate=await tx.managedRun.findFirst({where:{ownerId,taskId,status:{in:active}}});
    if(!duplicate&&await tx.managedRun.count({where:{ownerId,status:{in:active}}})>=5)throw new WorkspaceError('At most five active submissions per user',409);
    const parsed=JSON.parse(task.raw);
    const settings={stage:parsed.params.stage,times:parsed.params.times};fightTask(settings);
    const id=randomUUID();
    const snapshot:Submission={id,ownerId,taskId,taskName:task.name,accountId:task.account.id,accountMatcher:task.account.matcher,settings};
    return tx.managedRun.create({data:{id,ownerId,taskId,taskName:task.name,snapshot:JSON.stringify(snapshot),source,occurrence,
      status:duplicate?'skipped':'queued',reason:duplicate?'Duplicate task already active':'Account switching acceptance pending; dispatch is blocked',finishedAt:duplicate?new Date():null}});
  }
  async pending(){return this.db.managedRun.findMany({where:{status:{in:active}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:500});}
  async record(id:string,state:RunnerState) {
    await this.db.managedRun.updateMany({where:{id,status:{in:active}},data:{delivered:true,status:state.status,reason:state.reason,startedAt:state.startedAt?new Date(state.startedAt):null,finishedAt:state.finishedAt?new Date(state.finishedAt):null}});
  }
  async failedDelivery(id:string){await this.db.managedRun.updateMany({where:{id,status:{in:active}},data:{reason:'Runner unavailable; retrying safely'}});}
  async runs(ownerId:string,page=1){return this.db.managedRun.findMany({where:{ownerId},orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(page-1)*30,take:30,select:{id:true,taskId:true,taskName:true,status:true,source:true,reason:true,createdAt:true,startedAt:true,finishedAt:true,cancelRequested:true}});}
  async run(ownerId:string,id:string){const run=await this.db.managedRun.findFirst({where:{ownerId,id}});if(!run)throw new WorkspaceError('Run not found',404);return run;}
  async cancel(ownerId:string,id:string){await this.run(ownerId,id);await this.db.managedRun.updateMany({where:{ownerId,id,status:{in:active}},data:{cancelRequested:true}});return {ok:true};}
  async queue(ownerId:string){return this.db.managedRun.findMany({where:{ownerId,status:{in:active}},select:{id:true,taskId:true,taskName:true,status:true,reason:true,cancelRequested:true},orderBy:{createdAt:'asc'}});}
  async schedules(ownerId:string){return this.db.managedSchedule.findMany({where:{ownerId},orderBy:{nextAt:'asc'}});}
  async schedule(ownerId:string,body:any,id?:string) {
    if(!body||typeof body.taskId!=='string'||typeof body.enabled!=='boolean'||typeof body.expression!=='string'||body.expression.length>100)throw new WorkspaceError('Invalid schedule');
    const now=new Date();let nextAt:Date;
    try{nextAt=nextDate(body.type,body.expression,now);}catch{throw new WorkspaceError('Invalid schedule rule');}
    if(body.type==='interval'&&Number(body.expression)<10)throw new WorkspaceError('Schedule interval must be at least ten minutes');
    if(body.type==='cron') {
      const minutes=[...CronExpressionParser.parse(body.expression,{tz:scheduleTimeZone()}).fields.minute.values].sort((a,b)=>a-b);
      if(minutes.some((m,i)=>(minutes[(i+1)%minutes.length]+(i===minutes.length-1?60:0)-m)<10))throw new WorkspaceError('Cron minute slots must be at least ten minutes apart, including the hour boundary');
    }
    return serialTransaction(this.db,async tx=>{
      if(!await tx.managedTask.findFirst({where:{id:body.taskId,ownerId}}))throw new WorkspaceError('Task not found',404);
      const data={taskId:body.taskId,name:label(body.name),type:body.type,expression:body.expression,enabled:body.enabled,nextAt};
      if(id){if((await tx.managedSchedule.updateMany({where:{id,ownerId},data})).count!==1)throw new WorkspaceError('Schedule not found',404);return tx.managedSchedule.findUniqueOrThrow({where:{id}});}
      if(await tx.managedSchedule.count({where:{ownerId}})>=20)throw new WorkspaceError('Schedule quota reached',409);
      return tx.managedSchedule.create({data:{...data,ownerId}});
    });
  }
  async deleteSchedule(ownerId:string,id:string){if((await this.db.managedSchedule.deleteMany({where:{ownerId,id}})).count!==1)throw new WorkspaceError('Schedule not found',404);return {ok:true};}
  async scheduleTick(now=new Date(),startup=false) {
    for(const schedule of await this.db.managedSchedule.findMany({where:{enabled:true,nextAt:{lte:now}}})) {
      await serialTransaction(this.db,async tx=>{
        const nextAt=schedule.type==='interval'?new Date(schedule.nextAt.getTime()+(Math.floor((now.getTime()-schedule.nextAt.getTime())/(Number(schedule.expression)*60000))+1)*Number(schedule.expression)*60000):nextDate(schedule.type,schedule.expression,now);
        // Claim by previous nextAt so concurrent ticks and restart cannot duplicate.
        if((await tx.managedSchedule.updateMany({where:{id:schedule.id,enabled:true,nextAt:schedule.nextAt},data:{nextAt}})).count!==1)return;
        if(startup||now.getTime()-schedule.nextAt.getTime()>=15000)return;
        try {await this.submit(schedule.ownerId,schedule.taskId,'schedule',`${schedule.id}:${schedule.nextAt.toISOString()}`,tx);}
        catch(e){if(!(e instanceof WorkspaceError))throw e;await tx.auditEvent.create({data:{actorId:schedule.ownerId,action:'schedule-skipped',targetId:schedule.id}});}
      });
    }
  }
}
