import http from 'node:http';
import {RunnerPort,RunnerState,Submission} from './contracts';

/** Fixed RPC endpoint over a private Unix socket; callers cannot choose paths/commands. */
export class SocketRunner implements RunnerPort {
  constructor(private socketPath:string,private origin:string) {}
  private request<T>(operation:string,body:unknown):Promise<T> {
    return new Promise((resolve,reject)=>{
      const req=http.request({socketPath:this.socketPath,path:'/api/internal/managed',method:'POST',headers:{origin:this.origin,'x-maa-request':'1','content-type':'application/json'}},res=>{
        let size=0;const chunks:Buffer[]=[];
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>262144){res.destroy();reject(Error('Runner response limit'));}else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try {if(res.statusCode!==200)throw Error('Runner rejected request');resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(e){reject(e);}});
      });
      const deadline=setTimeout(()=>req.destroy(Error('Runner deadline exceeded')),5000);
      req.on('close',()=>clearTimeout(deadline));
      req.setTimeout(5000,()=>req.destroy(Error('Runner timeout')));req.on('error',reject);req.end(JSON.stringify({operation,...body as object}));
    });
  }
  submit(job:Submission){return this.request<RunnerState>('submit',{job});}
  status(){return this.request<{paused:boolean}>('status',{});}
  read(ownerId:string,id:string){return this.request<RunnerState|null>('read',{ownerId,id});}
  cancel(ownerId:string,id:string){return this.request<RunnerState>('cancel',{ownerId,id});}
  log(ownerId:string,id:string,cursor:number){return this.request<{base64:string;cursor:number}>('log',{ownerId,id,cursor});}
}
