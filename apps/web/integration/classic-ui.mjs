import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID, createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {chromium} from 'playwright-core';

// Explicit integration command, never part of production startup or the default unit suite.
if (process.platform !== 'win32') throw Error('This harness exercises Windows Named Pipe transport');
const source = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const id = randomUUID();
const root = path.join(source, '.cache', 'classic-integration', id);
const pipe = '\\\\.\\pipe\\maa-classic-' + id;
const children = new Map();
const evidence = {id, source, root, platform:process.platform, node:process.version, isolation:{loopbackOnly:true,productionAccess:false,realDeviceAccess:false,transport:'Windows Named Pipe (socket chmod not applicable)'}, checks:[], services:[], status:'RUNNING'};
let browser, db, gateway, context;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
await fs.mkdir(root,{recursive:true});
evidence.sourceHashes={};
for(const relative of ['apps/server/dist/main.js','apps/server/dist/portal.js','apps/web/integration/classic-ui.mjs','apps/web/integration/windows-isolation.cjs',
  'apps/web/src/TaskConfig.tsx','apps/web/src/taskEditor.ts','apps/web/src/taskSchema.ts','apps/web/src/useRunnerStatus.ts','package-lock.json',
  'apps/web/dist/index.html',...(await fs.readdir(path.join(source,'apps/web/dist/assets'))).map(n=>'apps/web/dist/assets/'+n)]){
  evidence.sourceHashes[relative]=hash(await fs.readFile(path.join(source,relative)));
}
const cleanEnv = Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','LOCALAPPDATA'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const port = async () => {
  const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const number=server.address().port;await new Promise(resolve=>server.close(resolve));return number;
};
const portalPort=await port(), tlsPort=await port(), origin=`https://127.0.0.1:${tlsPort}`;
const env={...cleanEnv,DATABASE_URL:'file:'+path.join(root,'integration.sqlite').replaceAll('\\','/'),DATA_DIR:root,MAA_CONFIG_DIR:path.join(root,'config'),
  DEVICE_CONFIG:path.join(root,'device.json'),MAA_BIN:process.execPath,ADB_BIN:path.join(root,'NO_REAL_ADB.exe'),DISPLAY_URL:'http://127.0.0.1:1',DEVICE_URL:'http://127.0.0.1:1',
  PUBLIC_ORIGIN:origin,WEB_DIR:path.join(source,'apps/web/dist'),RUNNER_SOCKET:pipe,RUNNER_SOCKET_ONLY:'1',PORT:String(portalPort),LISTEN_HOST:'127.0.0.1',
  CLASSIC_SOURCE_ROOT:source,CLASSIC_TEST_ROOT:root,CLASSIC_LOCAL_ISOLATION:'1',NODE_OPTIONS:'--require='+JSON.stringify(path.join(source,'apps/web/integration/windows-isolation.cjs'))};
const launch = role => {
  const log=createWriteStream(path.join(root,role+'.log'),{flags:'a'});
  const child=spawn(process.execPath,['--max-old-space-size=384',path.join(source,'apps/server/dist',role==='manager'?'main.js':'portal.js')],
    {cwd:root,env:{...env,CLASSIC_TEST_ROLE:role},stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.pipe(log);child.stderr.pipe(log);
  children.set(child,{role,pid:child.pid,root});
  evidence.services.push({role,pid:child.pid,executable:process.execPath,entry:child.spawnargs.at(-1),root,started:new Date().toISOString()});
  return child;
};
const stop = async child => {
  if (!child || !children.has(child) || children.get(child).pid!==child.pid || children.get(child).root!==root) throw Error('Unowned process');
  if (child.exitCode!==null || child.signalCode!==null) return;
  const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();
  await Promise.race([ended,pause(10000).then(()=>{throw Error('Owned service failed to stop');})]);
};
const ready = async fn => {
  const deadline=Date.now()+20000;let last;
  while(Date.now()<deadline){try{return await fn();}catch(e){last=e;await pause(100);}}
  throw last || Error('Readiness timeout');
};
const pipeRequest = route => new Promise((resolve,reject)=>{
  const request=http.get({socketPath:pipe,path:'/api/'+route},reply=>{let text='';reply.on('data',v=>text+=v);reply.on('end',()=>reply.statusCode===200?resolve(JSON.parse(text)):reject(Error(text)));});
  request.setTimeout(3000,()=>request.destroy(Error('Pipe timeout')));request.on('error',reject);
});
const fixture={name:'Integration daily',client_type:'Official',startup:false,closedown:false,future:{nested:[null,{keep:true}]},tasks:[
  {type:'Fight',name:'Battle',params:{stage:'1-7',times:4,medicine:0,stone:0,medicine_expire_days:0,expiring_medicine:5,series:{default:1,description:'Synthetic template'},future_param:{list:[null,7]}},strategy:'merge',variants:[{condition:{type:'Weekday',weekdays:['Mon']},params:{stage:'CE-6',times:{default:2}},future_variant:{flag:false}}],future_task:{nested:['preserve']}},
  {type:'Award',name:'Rewards',params:{award:true,future_award:[1,null]}},
  {type:'FutureTask',name:'Future',params:{future:{nested:true}},extension:{preserve:true}},
]};
const taskFile=path.join(root,'config/tasks/daily.json');
const readDoc=async()=>JSON.parse(await fs.readFile(taskFile,'utf8'));
let page;
const api=async(route,method='GET',body)=>page.evaluate(async({route,method,body})=>{
  const response=await fetch('/api/'+route,{method,headers:{'content-type':'application/json','x-maa-request':'1'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
},{route,method,body});
const check=async(name,fn)=>{
  const started=new Date().toISOString();
  try{await fn();evidence.checks.push({name,started,ended:new Date().toISOString(),status:'PASS'});console.log('PASS',name);}
  catch(e){evidence.checks.push({name,started,ended:new Date().toISOString(),status:'FAIL',error:String(e.stack||e)});throw e;}
};
const editor=()=>page.locator('.classic-editor');
const button=name=>editor().getByRole('button',{name,exact:true});
const selectDaily=async()=>{await page.locator('nav').getByRole('button',{name:/^任务配置/}).click();await page.getByLabel('当前预设',{exact:true}).selectOption('daily');await page.locator('.classic-task-row').first().waitFor();};
const save=async()=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/tasks/daily')&&r.request().method()==='PUT');await button('保存').click();assert.equal((await response).status(),200);await button('保存').waitFor({state:'visible'});await ready(async()=>assert.equal(await button('保存').isDisabled(),true));};
try {
  await fs.mkdir(path.dirname(taskFile),{recursive:true});
  await fs.writeFile(taskFile,JSON.stringify(fixture,null,2));
  await fs.writeFile(path.join(root,'device-state.json'),JSON.stringify({ready:true}));
  await fs.writeFile(path.join(root,'device.json'),JSON.stringify({version:1,transport:'usb',serial:'FAKE-USB',packageName:'test.invalid'}));
  await fs.writeFile(path.join(root,'version'),`require('node:fs').appendFileSync(${JSON.stringify(path.join(root,'fake-cli.jsonl'))},JSON.stringify({args:process.argv.slice(1)})+'\\n');console.log('Fake MAA CLI version probe only');`);
  // Fail closed: a mistaken execution never reaches a real CLI/Core or device.
  await fs.writeFile(path.join(root,'run'),`throw Error('Integration must never execute a game task');`);
  const {NODE_OPTIONS,...migrationEnv}=env;
  await exec(process.execPath,[path.join(source,'node_modules/prisma/build/index.js'),'migrate','deploy','--schema',path.join(source,'apps/server/prisma/schema.prisma')],{cwd:root,env:migrationEnv,timeout:30000,windowsHide:true});
  db=new PrismaClient({datasources:{db:{url:env.DATABASE_URL}}});
  await db.schedule.create({data:{id:'classic-fixture-schedule',name:'Synthetic future schedule',task:'daily',type:'weekly',expression:'1 06:00',enabled:true,nextAt:new Date('2099-01-01T00:00:00Z')}});
  const scheduleBefore=JSON.stringify(await db.schedule.findMany());
  const migrationsBefore=await db.$queryRawUnsafe('SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name');
  const openssl=process.env.CLASSIC_OPENSSL;
  if (!openssl || !path.isAbsolute(openssl)) throw Error('CLASSIC_OPENSSL must be an explicit local executable path');
  await fs.writeFile(path.join(root,'tls.cnf'),'[req]\ndistinguished_name=dn\n[dn]\n');
  await exec(openssl,['req','-config',path.join(root,'tls.cnf'),'-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'test-key.pem'),'-out',path.join(root,'test-cert.pem'),'-days','1','-subj','/CN=localhost'],{cwd:root,env:cleanEnv,timeout:20000,windowsHide:true});
  let manager=launch('manager');
  await ready(async()=>assert.equal((await pipeRequest('health')).ok,true));
  launch('portal');
  await ready(async()=>assert.equal((await fetch(`http://127.0.0.1:${portalPort}/api/health`)).status,200));
  gateway=https.createServer({key:await fs.readFile(path.join(root,'test-key.pem')),cert:await fs.readFile(path.join(root,'test-cert.pem'))},(request,response)=>{
    const upstream=http.request({hostname:'127.0.0.1',port:portalPort,path:request.url,method:request.method,headers:request.headers},reply=>{response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);});
    upstream.setTimeout(10000,()=>upstream.destroy());upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});response.on('close',()=>upstream.destroy());request.pipe(upstream);
  });
  await new Promise(resolve=>gateway.listen(tlsPort,'127.0.0.1',resolve));
  const executablePath=process.env.CLASSIC_CHROME;
  if(!executablePath || !path.isAbsolute(executablePath)) throw Error('CLASSIC_CHROME must be an explicit local browser executable');
  browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-sync','--no-proxy-server']});
  evidence.browser={version:browser.version(),executablePath,desktop:{width:1440,height:1000},mobile:{width:390,height:844}};
  context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:true,locale:'zh-CN',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(origin);await selectDaily();
  await check('real Portal → Named Pipe → Manager health, SQLite and preset load',async()=>{
    assert.equal((await api('health')).data.ok,true);assert.deepEqual((await api('tasks/daily')).data.raw,JSON.stringify(fixture,null,2));
    assert.equal(await page.getByLabel('启用任务 Battle',{exact:true}).isChecked(),true);
    assert.equal(await button('运行').isDisabled(),true);
    assert.match(await editor().innerText(),/队列已暂停/);
  });
  await check('disable/save/refresh/re-enable preserves variants, strategy, templates and unknown fields',async()=>{
    await page.getByLabel('启用任务 Battle',{exact:true}).uncheck();await save();
    const disabled=await readDoc();assert.deepEqual(disabled.tasks[0].params,fixture.tasks[0].params);assert.equal(disabled.tasks[0].variants[0].condition.type,'And');
    await page.reload();await selectDaily();assert.equal(await page.getByLabel('启用任务 Battle',{exact:true}).isChecked(),false);
    await page.getByLabel('启用任务 Battle',{exact:true}).check();await save();assert.deepEqual(await readDoc(),fixture);
  });
  await check('gear selects details, arrow sorting follows the selected task',async()=>{
    await page.getByLabel('设置 Rewards',{exact:true}).click();assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),'Rewards');
    await page.getByLabel('上移任务',{exact:true}).click();await save();assert.deepEqual((await readDoc()).tasks.map(t=>t.name),['Rewards','Battle','Future']);
    await page.getByLabel('下移任务',{exact:true}).click();await save();assert.deepEqual((await readDoc()).tasks,fixture.tasks);
  });
  await check('native browser drag/drop reports target and persists execution order',async()=>{
    const handle=page.getByLabel('拖动排序 Battle',{exact:true});const target=page.locator('.classic-task-row').nth(1);
    await page.evaluate(()=>{
      window.classicDropFeedback=false;
      window.classicDropObserver=new MutationObserver(records=>{if(records.some(r=>r.target.classList?.contains('drop-target')))window.classicDropFeedback=true;});
      window.classicDropObserver.observe(document.querySelector('.classic-workbench'),{subtree:true,attributes:true,attributeFilter:['class']});
    });
    await handle.dragTo(target);
    assert.equal(await page.evaluate(()=>{window.classicDropObserver.disconnect();return window.classicDropFeedback;}),true);
    await save();assert.deepEqual((await readDoc()).tasks.map(t=>t.name),['Rewards','Battle','Future']);
    assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),'Rewards');
    await page.getByLabel('设置 Battle',{exact:true}).click();
    await page.getByLabel('上移任务',{exact:true}).click();await save();assert.deepEqual((await readDoc()).tasks,fixture.tasks);
  });
  await check('add/deep-copy/confirm-delete tasks without touching another preset',async()=>{
    await page.getByLabel('添加任务',{exact:true}).selectOption('Recruit');await button('复制任务').click();
    assert.equal(await page.locator('.classic-task-row').count(),5);await button('删除任务').click();await editor().getByRole('button',{name:'取消',exact:true}).click();
    for(let i=0;i<2;i++){await button('删除任务').click();await page.locator('.modal').getByRole('button',{name:'删除任务',exact:true}).click();}
    await save();assert.deepEqual((await readDoc()).tasks,fixture.tasks);
  });
  await check('basic and advanced controls edit only intended fields; complex values remain intact',async()=>{
    await page.getByLabel('设置 Battle',{exact:true}).click();
    await page.getByLabel('战斗次数',{exact:true}).fill('6');
    await page.locator('.advanced-params summary').click();
    await page.getByLabel('企鹅数据汇报 ID',{exact:true}).fill('SYNTHETIC-ID');
    await save();const doc=await readDoc();assert.equal(doc.tasks[0].params.times,6);assert.deepEqual(doc.tasks[0].params.series,fixture.tasks[0].params.series);assert.deepEqual(doc.future,fixture.future);
    await page.screenshot({path:path.join(root,'desktop.png'),fullPage:true});
  });
  await check('raw/visual round-trip and false flags preserve complex document and Schedule ID',async()=>{
    await button('原始 JSON').click();const doc=JSON.parse(await page.getByLabel('任务 JSON',{exact:true}).inputValue());doc.tasks[0].params.times=4;doc.extra_from_raw={nested:[null,42]};
    await page.getByLabel('任务 JSON',{exact:true}).fill(JSON.stringify(doc));await button('可视化').click();await save();
    assert.deepEqual(await readDoc(),doc);assert.equal(doc.startup,false);assert.equal(doc.closedown,false);
    assert.equal(JSON.stringify(await db.schedule.findMany()),scheduleBefore);
  });
  await check('real preset clone/create/delete retains scheduled original ID and all complex fields',async()=>{
    const before=await readDoc();await button('复制预设').click();
    await page.locator('.modal').getByLabel('预设显示名',{exact:true}).fill('Integration copy');
    const created=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');
    await page.locator('.modal').getByRole('button',{name:'确定',exact:true}).click();assert.equal((await created).status(),201);
    await ready(async()=>assert.equal(await page.getByLabel('当前预设',{exact:true}).locator('option[value="integration-copy"]').count(),1));
    assert.deepEqual(JSON.parse((await api('tasks/integration-copy')).data.raw),{...before,name:'Integration copy'});
    await page.getByLabel('当前预设',{exact:true}).selectOption('integration-copy');
    await ready(async()=>assert.equal(await editor().getByLabel('预设显示名',{exact:true}).inputValue(),'Integration copy'));
    await button('删除预设').click();const deleted=page.waitForResponse(r=>r.url().endsWith('/api/tasks/integration-copy')&&r.request().method()==='DELETE');
    await page.locator('.modal').getByRole('button',{name:'删除',exact:true}).click();assert.equal((await deleted).status(),200);
    await ready(async()=>assert.equal(await page.getByLabel('当前预设',{exact:true}).inputValue(),''));
    assert.deepEqual(await readDoc(),before);assert.equal(JSON.stringify(await db.schedule.findMany()),scheduleBefore);
    await selectDaily();
  });
  await check('unsaved edits block preset navigation, run and browser refresh',async()=>{
    await page.getByLabel('任务名称',{exact:true}).fill('Battle unsaved');assert.equal(await button('运行').isDisabled(),true);
    await page.locator('nav').getByRole('button',{name:/^历史/}).click();assert.equal(await editor().count(),1);
    await page.getByRole('button',{name:'新建预设',exact:true}).click();assert.equal(await page.locator('.modal').count(),0);
    const dismiss=dialog=>dialog.dismiss();page.once('dialog',dismiss);await page.reload().catch(()=>{});
    assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),'Battle unsaved');await save();
  });
  await check('real 409 conflict preserves draft and external writer data',async()=>{
    await page.getByLabel('任务名称',{exact:true}).fill('Browser conflict draft');const current=(await api('tasks/daily')).data;
    const outside=JSON.parse(current.raw);outside.other_writer={keep:true};
    assert.equal((await api('tasks/daily','PUT',{raw:JSON.stringify(outside),version:current.version})).status,200);
    const response=page.waitForResponse(r=>r.url().endsWith('/api/tasks/daily')&&r.request().method()==='PUT');await button('保存').click();assert.equal((await response).status(),409);
    assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),'Browser conflict draft');assert.deepEqual((await readDoc()).other_writer,{keep:true});
    assert.equal(await button('运行').isDisabled(),true);
    page.once('dialog',dialog=>dialog.accept());await page.reload();await selectDaily();
  });
  await check('paused/device unavailable/stale state fail closed without submitting a task',async()=>{
    assert.equal(await button('运行').isDisabled(),true);
    await fs.writeFile(path.join(root,'device-state.json'),JSON.stringify({ready:false}));
    await ready(async()=>assert.equal((await api('status')).data.adb,false));
    await api('queue','POST',{action:'resume'});
    await ready(async()=>{assert.equal(await button('运行').isDisabled(),true);assert.match(await editor().innerText(),/受阻|未就绪/);});
    await fs.writeFile(path.join(root,'device-state.json'),JSON.stringify({ready:true}));
    await ready(async()=>assert.equal((await api('status')).data.adb,true));
    await ready(async()=>assert.equal(await button('运行').isDisabled(),false));
    await api('queue','POST',{action:'pause'});
    await stop(manager);await ready(async()=>{assert.equal(await button('运行').isDisabled(),true);assert.match(await editor().innerText(),/运行状态未确认/);});
    manager=launch('manager');await ready(async()=>assert.equal((await api('health')).status,200));
    await ready(async()=>assert.match(await editor().innerText(),/队列已暂停，不能运行/));
  });
  await check('390px actual viewport: no horizontal overflow, task settings and save remain usable',async()=>{
    await page.setViewportSize({width:390,height:844});await page.getByLabel('设置 Rewards',{exact:true}).click();
    assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),'Rewards');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.getByLabel('任务名称',{exact:true}).fill('Mobile rewards');await save();
    await page.screenshot({path:path.join(root,'mobile.png'),fullPage:true});
  });
  await check('final real database/config invariants, no task execution and no browser exceptions',async()=>{
    assert.equal(await db.run.count(),0);assert.equal(JSON.stringify(await db.schedule.findMany()),scheduleBefore);
    assert.deepEqual(await db.$queryRawUnsafe('PRAGMA integrity_check'),[{integrity_check:'ok'}]);
    assert.deepEqual(await db.$queryRawUnsafe('PRAGMA foreign_key_check'),[]);
    assert.deepEqual(await db.$queryRawUnsafe('SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name'),migrationsBefore);
    assert.equal((await api('queue')).data.paused,true);assert.deepEqual((await api('queue')).data.items,[]);
    const probes=(await fs.readFile(path.join(root,'fake-cli.jsonl'),'utf8')).trim().split('\n').map(v=>JSON.parse(v));assert(probes.every(v=>path.basename(v.args[0])==='version'));
    const listeners=(await fs.readFile(path.join(root,'listeners.jsonl'),'utf8')).trim().split('\n').map(v=>JSON.parse(v));
    assert(listeners.every(v=>v.role==='manager'?v.args[0]===pipe:v.role==='portal'&&v.args[1]==='127.0.0.1'));
    evidence.listeners=listeners;evidence.gateway=gateway.address();
    assert.deepEqual(errors,[]);evidence.database={integrity:'ok',foreignKeys:0,runs:0,scheduleUnchanged:true,migrationsUnchanged:true};evidence.finalDocumentSha256=hash(await fs.readFile(taskFile));
  });
  evidence.status='PASS';
} catch(error) {
  evidence.status='FAIL';evidence.error=String(error.stack||error);console.error(error);
  if(page) await page.screenshot({path:path.join(root,'failure.png'),fullPage:true}).catch(()=>{});
  process.exitCode=1;
} finally {
  if(browser) await browser.close();
  for(const child of [...children.keys()].reverse()) await stop(child).catch(e=>{evidence.cleanupError=String(e);process.exitCode=1;});
  if(gateway){gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));}
  if(db) await db.$disconnect();
  evidence.ended=new Date().toISOString();evidence.processesStopped=[...children.keys()].every(c=>c.exitCode!==null||c.signalCode!==null);
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify(evidence,null,2));
  console.log('RESULT',evidence.status,'EVIDENCE',root);
}
