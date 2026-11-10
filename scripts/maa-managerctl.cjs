#!/usr/bin/env node
const http=require('node:http');
const [command,argument]=process.argv.slice(2);
const routes={status:['GET','/api/status'],queue:['GET','/api/queue'],pause:['POST','/api/queue',{action:'pause'}],resume:['POST','/api/queue',{action:'resume'}],run:['POST',`/api/tasks/${encodeURIComponent(argument||'')}/run`,{}],stop:['POST',`/api/runs/${encodeURIComponent(argument||'')}/stop`,{}]};
if(!routes[command]){console.error('Usage: maa-managerctl status|queue|pause|resume|run TASK|stop RUN_ID');process.exit(2);}
const [method,path,body]=routes[command];
const req=http.request({socketPath:process.env.RUNNER_SOCKET||(process.env.DATA_DIR||'/data')+'/control.sock',path,method,headers:{Origin:process.env.PUBLIC_ORIGIN,'X-Maa-Request':'1','Content-Type':'application/json'}},res=>{res.pipe(process.stdout);res.on('end',()=>{if(res.statusCode>=400)process.exitCode=1;});});
req.on('error',e=>{console.error(e.message);process.exitCode=1;});req.end(body?JSON.stringify(body):undefined);
