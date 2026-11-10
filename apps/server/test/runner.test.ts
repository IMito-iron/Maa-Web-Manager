import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

test('Linux real Runner serializes shared control and FIFO dispatch; restart keeps queued work paused',{skip:process.platform==='win32'},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-shared-runner-')),socket=path.join(dir,'control.sock');let child:ReturnType<typeof spawn>|undefined;
  const env={...process.env,DATABASE_URL:'file:'+path.join(dir,'db.sqlite'),DATA_DIR:dir,MAA_CONFIG_DIR:path.join(dir,'config'),DEVICE_CONFIG:path.join(dir,'device.json'),MAA_BIN:path.join(dir,'maa'),ADB_BIN:path.join(dir,'adb'),DISPLAY_URL:'http://127.0.0.1:1',PUBLIC_ORIGIN:'https://test.invalid',RUNNER_SOCKET:socket,RUNNER_SOCKET_ONLY:'1'};
  const call=(route:string,method='GET',body?:any,token='a'.repeat(64))=>new Promise<any>((resolve,reject)=>{const req=http.request({agent:false,socketPath:socket,path:'/api/'+route,method,headers:{origin:env.PUBLIC_ORIGIN,'content-type':'application/json','x-maa-request':'1','x-control-token':token,...(body?{'content-length':Buffer.byteLength(JSON.stringify(body))}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(e){reject(e);}});});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  const launch=async()=>{child=spawn(process.execPath,['dist/main.js'],{env,stdio:'pipe'});for(let i=0;i<100;i++){if(await call('health').then(r=>r.status===200).catch(()=>false))return;await new Promise(r=>setTimeout(r,50));}throw Error('Runner unavailable');};
  const stop=async()=>{child!.kill();await new Promise<void>(r=>child!.once('exit',()=>r()));};
  try {
    await fs.writeFile(env.DEVICE_CONFIG,JSON.stringify({version:1,transport:'usb',serial:'TEST',packageName:'com.hypergryph.arknights'}));
    await fs.writeFile(env.ADB_BIN,'#!/bin/sh\ncase "$*" in *devices*) echo "TEST device usb:1-1";; *get-state*) echo device;; *"dumpsys power"*) echo "mWakefulness=Awake";; *"dumpsys window policy"*) printf "KeyguardServiceDelegate\\n showing=false\\n";; *) echo 1;; esac\n',{mode:0o755});
    await fs.writeFile(env.MAA_BIN,'#!/bin/sh\n[ "$1" = version ] && exit 0\necho running\nsleep 2\n',{mode:0o755});
    await promisify(execFile)(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy','--schema','prisma/schema.prisma'],{env});
    await launch();assert.equal((await fs.stat(socket)).mode&0o777,0o600);
    assert.equal((await call('control','POST',{})).body.owned,true);
    const raw=JSON.stringify({tasks:[{type:'StartUp',params:{}}]});
    for(const name of ['one','two'])assert.equal((await call('tasks','POST',{name,raw})).status,201);
    const one=(await call('tasks/one/run','POST',{})).body,two=(await call('tasks/two/run','POST',{})).body;
    await call('queue','POST',{action:'resume'});await new Promise(r=>setTimeout(r,1500));assert.equal((await call('runs/'+one.id)).body.status,'queued');
    assert.equal((await call('control','DELETE',{})).status,200);
    for(let i=0;i<80;i++){if((await call('runs/'+one.id)).body.status==='running')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal((await call('runs/'+one.id)).body.status,'running',JSON.stringify((await call('status')).body));assert.equal((await call('control','POST',{})).status,409);
    await stop();await launch();assert.equal((await call('runs/'+one.id)).body.status,'interrupted');assert.equal((await call('runs/'+two.id)).body.status,'queued');assert.equal((await call('queue')).body.paused,true);
    assert.equal((await call('control')).body.held,false);
    // The editor previews a rule through the same code that stores it, and rejects bad input
    // the same way a save would, so the two can never disagree.
    const preview=await call('schedules/preview','POST',{type:'daily',expression:'06:00'});
    assert.equal(preview.status,201);assert.ok(Date.parse(preview.body.nextAt)>Date.now(),JSON.stringify(preview.body));
    assert.equal((await call('schedules/preview','POST',{type:'daily',expression:'25:99'})).status,400);
    assert.equal((await call('schedules/preview','POST',{type:'nope',expression:'x'})).status,400);
    assert.equal((await call('schedules/preview','POST',{expression:'06:00'})).status,400);
  }finally{if(child&&child.exitCode===null)await stop();await fs.rm(dir,{recursive:true,force:true});}
});
