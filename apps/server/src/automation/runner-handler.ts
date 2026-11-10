import {serialTransaction} from '../transaction';
import {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';
import {fightTask,label,WorkspaceError} from '../workspace/policy';
import {RunnerState,Submission} from './contracts';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const state=(r:any):RunnerState=>({id:r.id,status:r.status,reason:r.reason,startedAt:r.startedAt?.toISOString()??null,finishedAt:r.finishedAt?.toISOString()??null});
export interface ManagedRunControl {
  status():{paused:boolean};
  stop(id:string):Promise<unknown>;
  log(id:string,cursor:number):Promise<{base64:string;cursor:number}>;
}
export class ManagedRunnerHandler {
  constructor(private db:PrismaClient,private control:ManagedRunControl) {}
  async handle(body:any) {
    if(body?.operation==='status')return this.control.status();
    if(body?.operation==='submit')return this.submit(body.job);
    if(!uuid(body?.id)||!uuid(body?.ownerId))throw new WorkspaceError('Invalid run identity');
    const {id,ownerId}=body;
    const run=await this.db.run.findFirst({where:{id,ownerId}});
    if(body.operation==='read')return run?state(run):null;
    if(body.operation==='cancel') {
      await serialTransaction(this.db,async tx=>{
        const existing=await tx.runCancellation.findUnique({where:{id}});
        if(existing&&existing.ownerId!==ownerId)throw new WorkspaceError('Run not found',404);
        const other=await tx.run.findUnique({where:{id}});
        if(other&&other.ownerId!==ownerId)throw new WorkspaceError('Run not found',404);
        await tx.runCancellation.upsert({where:{id},create:{id,ownerId},update:{}});
        await tx.run.updateMany({where:{id,ownerId,status:'queued'},data:{status:'cancelled',finishedAt:new Date(),reason:'Cancelled by owner'}});
      });
      if(run?.status==='running')await this.control.stop(id);
      const current=await this.db.run.findFirst({where:{id,ownerId}});
      return current?state(current):{id,status:'cancelled',reason:'Cancelled before delivery',startedAt:null,finishedAt:new Date().toISOString()};
    }
    if(body.operation==='log') {
      if(!run){if(await this.db.runCancellation.findFirst({where:{id,ownerId}}))return {base64:'',cursor:0};throw new WorkspaceError('Run not found',404);}
      if(!Number.isSafeInteger(body.cursor)||body.cursor<0)throw new WorkspaceError('Invalid log cursor');
      return this.control.log(id,body.cursor);
    }
    throw new WorkspaceError('Unknown Runner operation');
  }
  private async submit(job:Submission) {
    if(!job||![job.id,job.ownerId,job.taskId,job.accountId].every(uuid))throw new WorkspaceError('Invalid submission');
    if(Object.keys(job).some(key=>!['id','ownerId','taskId','taskName','accountId','accountMatcher','settings'].includes(key)))throw new WorkspaceError('Unsupported submission field');
    const taskName=label(job.taskName),accountMatcher=label(job.accountMatcher);
    if(/[\r\n\x00]/.test(accountMatcher))throw new WorkspaceError('Invalid matcher');
    const raw=fightTask(job.settings);
    const snapshot=JSON.stringify({taskId:job.taskId,taskName,accountId:job.accountId,accountMatcher,task:JSON.parse(raw)});
    const hash=createHash('sha256').update(snapshot).digest('hex');
    return serialTransaction(this.db,async tx=>{
      const existing=await tx.run.findUnique({where:{id:job.id}});
      if(existing){if(existing.ownerId!==job.ownerId||existing.hash!==hash)throw new WorkspaceError('Submission identity conflict',409);return state(existing);}
      const cancelled=await tx.runCancellation.findUnique({where:{id:job.id}});
      if(cancelled&&cancelled.ownerId!==job.ownerId)throw new WorkspaceError('Submission identity conflict',409);
      const duplicate=await tx.run.findFirst({where:{ownerId:job.ownerId,managedTaskId:job.taskId,status:{in:['queued','running']}}});
      if(!cancelled&&!duplicate&&await tx.run.count({where:{ownerId:job.ownerId,status:{in:['queued','running']}}})>=5)throw new WorkspaceError('Runner quota exceeded',409);
      const status=cancelled?'cancelled':duplicate?'skipped':'queued';
      return state(await tx.run.create({data:{id:job.id,ownerId:job.ownerId,managedTaskId:job.taskId,task:taskName,hash,snapshot,status,source:'managed',reason:status==='queued'?'Account switching acceptance pending; dispatch blocked':status==='cancelled'?'Cancelled before delivery':'Duplicate task',finishedAt:status==='queued'?null:new Date()}}));
    });
  }
}
