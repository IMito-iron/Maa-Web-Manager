// Low-risk real-MAA acceptance: only launch/recognize the game, no recruitment or spending.
const http=require('node:http');
function req(path,method='GET',body){return new Promise((resolve,reject)=>{const payload=body?JSON.stringify(body):'';const r=http.request({socketPath:'/data/control.sock',path:'/api/'+path,method,headers:{Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'X-Maa-Request':'1'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{const b=JSON.parse(text);res.statusCode>=400?reject(Error(text)):resolve(b);}catch(e){reject(e);}});});r.on('error',reject);r.end(payload);});}
(async()=>{
const task=await req('tasks','POST',{name:'migration_smoke',raw:JSON.stringify({tasks:[{type:'StartUp',params:{client_type:'Official',start_game_enabled:true}}]})});
const run=await req('tasks/migration_smoke/run','POST',{});await req('queue','POST',{action:'resume'});console.log('Smoke run',run.id);
let result;for(let i=0;i<180;i++){result=await req('runs/'+run.id);if(!['queued','running'].includes(result.status))break;await new Promise(r=>setTimeout(r,1000));}
await req('queue','POST',{action:'pause'});
if(result.status!=='success'){if(result.status==='running')await req('runs/'+run.id+'/stop','POST',{});throw Error('Smoke result: '+JSON.stringify(result));}
await req('tasks/migration_smoke','DELETE',{version:task.version});console.log('PASS real MAA StartUp',run.id);
})().catch(e=>{console.error(e.message);process.exit(1)});
