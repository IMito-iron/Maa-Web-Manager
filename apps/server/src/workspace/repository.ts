import {serialTransaction} from '../transaction';
import {PrismaClient} from '@prisma/client';
import {WorkspaceRepository} from './service';
import {WorkspaceError} from './policy';
export class PrismaWorkspaceRepository implements WorkspaceRepository {
  constructor(private db:PrismaClient) {}
  accounts(ownerId:string){return this.db.gameAccount.findMany({where:{ownerId},orderBy:{createdAt:'asc'}});}
  tasks(ownerId:string){return this.db.managedTask.findMany({where:{ownerId},orderBy:{createdAt:'desc'}});}
  account(ownerId:string,id:string){return this.db.gameAccount.findFirst({where:{ownerId,id}});}
  task(ownerId:string,id:string){return this.db.managedTask.findFirst({where:{ownerId,id}});}
  async createAccount(ownerId:string,label:string,matcher:string) {
    return serialTransaction(this.db,async tx=>{
      if(await tx.gameAccount.count({where:{ownerId}})>=5)throw new WorkspaceError('Account limit reached',409);
      try {return await tx.gameAccount.create({data:{ownerId,label,matcher}});}
      catch(e:any){if(e.code==='P2002')throw new WorkspaceError('Account matcher unavailable',409);throw e;}
    });
  }
  async save(ownerId:string,data:Parameters<WorkspaceRepository['save']>[1],id?:string,expectedVersion?:string) {
    return serialTransaction(this.db,async tx=>{
      if(id) {
        if(await tx.managedRun.count({where:{taskId:id,ownerId,status:{in:['queued','running']}}}))throw new WorkspaceError('Task is queued or running',409);
        if(typeof expectedVersion!=='string')throw new WorkspaceError('Version required',409);
        const result=await tx.managedTask.updateMany({where:{ownerId,id,version:expectedVersion},data});
        if(result.count!==1)throw new WorkspaceError('Task changed; reload first',409);
        return tx.managedTask.findUniqueOrThrow({where:{id}});
      }
      if(await tx.managedTask.count({where:{ownerId}})>=100)throw new WorkspaceError('Task limit reached',409);
      return tx.managedTask.create({data:{...data,ownerId}});
    });
  }
  async remove(ownerId:string,id:string,version:string) {
    if(typeof version!=='string')return false;
    return serialTransaction(this.db,async tx=>{
      if(await tx.managedRun.count({where:{ownerId,taskId:id,status:{in:['queued','running']}}}))throw new WorkspaceError('Task is queued or running',409);
      if(await tx.managedSchedule.count({where:{ownerId,taskId:id}}))throw new WorkspaceError('Remove schedules referencing this task first',409);
      return (await tx.managedTask.deleteMany({where:{ownerId,id,version}})).count===1;
    });
  }
}
