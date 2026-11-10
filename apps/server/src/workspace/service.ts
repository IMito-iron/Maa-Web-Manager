import {fightTask,label,WorkspaceError,versionOf} from './policy';
export type Account={id:string;ownerId:string;label:string;matcher:string;verified:boolean};
export type Task={id:string;ownerId:string;accountId:string;name:string;raw:string;version:string};
export interface WorkspaceRepository {
  accounts(ownerId:string):Promise<Account[]>;
  createAccount(ownerId:string,label:string,matcher:string):Promise<Account>;
  tasks(ownerId:string):Promise<Task[]>;
  account(ownerId:string,id:string):Promise<Account|null>;
  task(ownerId:string,id:string):Promise<Task|null>;
  save(ownerId:string,data:{accountId:string;name:string;raw:string;version:string},id?:string,expectedVersion?:string):Promise<Task>;
  remove(ownerId:string,id:string,version:string):Promise<boolean>;
}
export class WorkspaceService {
  constructor(private repo:WorkspaceRepository) {}
  accounts(owner:string){return this.repo.accounts(owner);}
  tasks(owner:string){return this.repo.tasks(owner);}
  async createAccount(owner:string,body:any) {
    if(!body||Object.keys(body).some(k=>!['label','matcher'].includes(k)))throw new WorkspaceError('Only label and login matcher are accepted; never submit passwords');
    const matcher=label(body.matcher);
    if(/[\r\n\x00]/.test(matcher))throw new WorkspaceError('Invalid account matcher');
    return this.repo.createAccount(owner,label(body.label),matcher);
  }
  async task(owner:string,id:string) {
    const task=await this.repo.task(owner,id);if(!task)throw new WorkspaceError('Task not found',404);return task;
  }
  async save(owner:string,body:any,id?:string) {
    if(!body||typeof body.accountId!=='string')throw new WorkspaceError('Account required');
    if(!await this.repo.account(owner,body.accountId))throw new WorkspaceError('Account not found',404);
    if(id)await this.task(owner,id);
    const raw=fightTask(body.settings);
    return this.repo.save(owner,{accountId:body.accountId,name:label(body.name),raw,version:versionOf(raw+body.accountId+body.name)},id,body.version);
  }
  async remove(owner:string,id:string,version:string) {
    await this.task(owner,id);
    if(!await this.repo.remove(owner,id,version))throw new WorkspaceError('Task changed; reload first',409);
    return {ok:true};
  }
}
