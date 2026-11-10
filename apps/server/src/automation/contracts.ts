export type RunStatus='queued'|'running'|'success'|'failed'|'cancelled'|'interrupted'|'skipped';
export type Submission={id:string;ownerId:string;taskId:string;taskName:string;accountId:string;accountMatcher:string;settings:{stage:string;times:number}};
export type RunnerState={id:string;status:RunStatus;reason:string|null;startedAt:string|null;finishedAt:string|null};
export interface RunnerPort {
  status():Promise<{paused:boolean}>;
  submit(job:Submission):Promise<RunnerState>;
  read(ownerId:string,id:string):Promise<RunnerState|null>;
  cancel(ownerId:string,id:string):Promise<RunnerState>;
  log(ownerId:string,id:string,cursor:number):Promise<{base64:string;cursor:number}>;
}
export type Pending={id:string;ownerId:string;snapshot:string;delivered:boolean;cancelRequested:boolean};
export interface DeliveryRepository {
  pending():Promise<Pending[]>;
  record(id:string,state:RunnerState):Promise<void>;
  failedDelivery(id:string):Promise<void>;
  ownerEnabled(ownerId:string):Promise<boolean>;
}
export class DeliveryWorker {
  private busy=false;
  constructor(private repository:DeliveryRepository,private runner:RunnerPort) {}
  async tick() {
    if(this.busy)return;this.busy=true;
    try {
      for(const job of await this.repository.pending()) {
        try {
          const cancel=job.cancelRequested||!await this.repository.ownerEnabled(job.ownerId);
          const state=cancel?await this.runner.cancel(job.ownerId,job.id):
            job.delivered?await this.runner.read(job.ownerId,job.id):await this.runner.submit(JSON.parse(job.snapshot));
          // Never replay an acknowledged job lost from the Runner database.
          await this.repository.record(job.id,state??{id:job.id,status:'interrupted',reason:'Acknowledged Runner record missing; manual review required',startedAt:null,finishedAt:new Date().toISOString()});
        }catch{await this.repository.failedDelivery(job.id);}
      }
    }finally{this.busy=false;}
  }
}
