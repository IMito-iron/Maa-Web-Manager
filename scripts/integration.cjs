// Run against an isolated Manager configured with fake-maa/fake-adb.
const assert=require('node:assert/strict');
const base=process.env.TEST_URL||'http://127.0.0.1:3000';
async function req(p,method='GET',body,expected=200){const r=await fetch(base+'/api/'+p,{method,headers:{Origin:process.env.PUBLIC_ORIGIN||'https://maa.example.com','Content-Type':'application/json','X-Maa-Request':'1'},body:body===undefined?undefined:JSON.stringify(body)});const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));return b;}
const raw=JSON.stringify({future:42,tasks:[{type:'StartUp',params:{}}]});
async function wait(id,status){for(let n=0;n<80;n++){const r=await req('runs/'+id);if(r.status===status)return r;if(['failed','success','cancelled'].includes(r.status))throw Error(JSON.stringify(r));await new Promise(r=>setTimeout(r,300));}throw Error('timeout '+status);}
(async()=>{
assert.equal((await fetch(base+'/api/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
// fake-maa.sh reads fake_mode from the run snapshot; 'ok' keeps the plain document.
for(const name of ['ok','fail','slow','stubborn'])await req('tasks','POST',{name,raw:name==='ok'?raw:JSON.stringify({fake_mode:name,...JSON.parse(raw)})},201);
const config=await req('tasks/ok');assert.equal(config.raw,raw);
await req('tasks/ok','PUT',{raw,version:'stale'},409);
await req('tasks','POST',{name:'../bad',raw},400);
await req('tasks','POST',{name:'ok',raw},409);
const queued=await req('tasks/ok/run','POST',{},201);
assert.equal((await req('tasks/ok/run','POST',{},201)).status,'skipped');
await req('tasks/ok','PUT',{raw,version:config.version},409);
await req('queue','POST',{action:'resume'},201);await wait(queued.id,'success');
const failed=await req('tasks/fail/run','POST',{},201);assert.equal((await wait(failed.id,'failed')).exitCode,7);
const slow=await req('tasks/slow/run','POST',{},201);await wait(slow.id,'running');await req('runs/'+slow.id+'/stop','POST',{},201);await wait(slow.id,'cancelled');
const stubborn=await req('tasks/stubborn/run','POST',{},201);await wait(stubborn.id,'running');const stopTime=Date.now();await req('runs/'+stubborn.id+'/stop','POST',{},201);await wait(stubborn.id,'cancelled');assert(Date.now()-stopTime>=9000,'TERM-ignoring process should require escalation');
const s=await req('schedules','POST',{name:'test',task:'ok',type:'daily',expression:'05:10',enabled:true},201);await req('tasks/ok','DELETE',{version:config.version},409);await req('schedules/'+s.id,'DELETE',{},200);
const log=await fetch(base+'/api/runs/'+queued.id+'/log');assert.match(await log.text(),/任务完成/);
const abort=new AbortController();const stream=await fetch(base+'/api/runs/'+queued.id+'/events',{headers:{'Last-Event-ID':'5'},signal:abort.signal});const reader=stream.body.getReader();let event='';while(!event.includes('event: log'))event+=new TextDecoder().decode((await reader.read()).value);assert.match(event,/"cursor":/);abort.abort();
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
const timed=await req('schedules','POST',{name:'trigger-test',task:'ok',type:'interval',expression:'60',enabled:true},201);
await db.schedule.update({where:{id:timed.id},data:{nextAt:new Date(Date.now()+1500)}});
let scheduled;for(let i=0;i<30;i++){scheduled=await db.run.findFirst({where:{scheduleId:timed.id}});if(scheduled)break;await new Promise(r=>setTimeout(r,300));}assert(scheduled,'scheduler must create run');await wait(scheduled.id,'success');assert.equal(await db.run.count({where:{scheduleId:timed.id}}),1);
await req('queue','POST',{action:'pause'},201);await db.schedule.update({where:{id:timed.id},data:{nextAt:new Date(Date.now()-60000)}});await new Promise(r=>setTimeout(r,1600));assert.equal(await db.run.count({where:{scheduleId:timed.id}}),1,'paused occurrence must not replay');await req('schedules/'+timed.id,'DELETE',{},200);await req('queue','POST',{action:'resume'},201);await db.$disconnect();
await req('tasks/ok','DELETE',{version:config.version},200);
console.log('PASS: origin, CRUD conflicts, duplicate execution, exit code, TERM/KILL stop, schedule references/trigger/missed occurrence and log replay');
})().catch(e=>{console.error(e);process.exit(1);});
