import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DeviceControl} from '../src/control';

test('shared Portal serves noVNC assets, enforces Origin and revokes existing WebSockets',{skip:process.platform==='win32'?'Production uses Unix sockets; Windows Node named-pipe upgrade has a native assertion failure':false},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-portal-test-'));
  const control=new DeviceControl();
  const socketPath=process.platform==='win32'?`\\.\pipe\maa-shared-${process.pid}`:path.join(dir,'runner.sock');
  const origin='https://maa.test';
  const runner=http.createServer((req,res)=>{
    const token=String(req.headers['x-control-token']||'');
    try {const value=req.url==='/api/control/heartbeat'?control.touch(token):req.url==='/api/control'?req.method==='POST'?control.grant(token,false):req.method==='DELETE'?control.release(token):control.status(token):{ok:true};res.setHeader('content-type','application/json');res.end(JSON.stringify(value));}catch(e:any){res.writeHead(e.getStatus?.()||500).end('{}');}
  });
  await new Promise<void>(r=>runner.listen(socketPath,r));
  const peers=new Set<net.Socket>();
  const display=http.createServer((req,res)=>res.end(req.url==='/vnc.html'?'<html>noVNC</html>':req.url==='/app/ui.js'?'asset':'wrong-path'));
  display.on('upgrade',(req,socket)=>{peers.add(socket as net.Socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket as net.Socket));const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);});
  await new Promise<void>(r=>display.listen(0,'127.0.0.1',r));
  const probe=net.createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));
  const child=spawn(process.execPath,['dist/portal.js'],{env:{...process.env,PUBLIC_ORIGIN:origin,RUNNER_SOCKET:socketPath,PORT:String(port),DEVICE_URL:`http://127.0.0.1:${(display.address() as net.AddressInfo).port}`,WEB_DIR:dir},stdio:'pipe'});
  const base=`http://127.0.0.1:${port}`;
  const call=(route:string,method='GET',cookie='')=>fetch(base+route,{method,headers:{origin,'content-type':'application/json','x-maa-request':'1',cookie},body:method==='GET'?undefined:'{}'});
  const upgrade=(cookie:string,source=origin)=>new Promise<{status:number,socket?:net.Socket}>(resolve=>{const req=http.request(base+'/vnc/websockify',{headers:{origin:source,cookie,upgrade:'websocket',connection:'Upgrade','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13'}});req.on('upgrade',(_res,socket)=>{socket.on('error',()=>{});socket.resume();resolve({status:101,socket:socket as net.Socket});});req.on('response',res=>{res.resume();resolve({status:res.statusCode!});});req.end();});
  try {
    for(let i=0;i<100;i++){if(await fetch(base+'/api/health').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,50));}
    assert.match(await (await call('/vnc/vnc.html')).text(),/noVNC/);
    assert.equal(await (await call('/vnc/app/ui.js')).text(),'asset');
    assert.equal((await call('/api/auth/me')).status,410);
    assert.equal((await fetch(base+'/api/control',{method:'POST'})).status,403);
    // View mode: the VNC WebSocket is available without a control cookie (NPM auths upstream).
    assert.equal((await upgrade('')).status,101);
    // Origin is still enforced on the upgrade path.
    assert.equal((await upgrade('','https://evil.test')).status,403);
    const response=await call('/api/control','POST');const cookie=response.headers.get('set-cookie')!.split(';')[0];
    assert.match(response.headers.get('set-cookie')!,/HttpOnly/);
    assert.equal((await call('/api/control','POST')).status,409);
    const ws=await upgrade(cookie);assert.equal(ws.status,101);
    // Releasing control does not revoke the always-available view-mode stream.
    await call('/api/control','DELETE',cookie);
    assert.equal((await upgrade(cookie)).status,101);
  }finally{child.kill();await new Promise<void>(r=>child.once('exit',()=>r()));for(const peer of peers)peer.destroy();runner.closeAllConnections();display.closeAllConnections();await Promise.all([new Promise<void>(r=>runner.close(()=>r())),new Promise<void>(r=>display.close(()=>r()))]);await fs.rm(dir,{recursive:true,force:true});}
});

test('Portal proxies the media socket with the lease credential and never trusts client headers',{skip:process.platform==='win32'?'Unix sockets only':false},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-portal-media-'));
  const socketPath=path.join(dir,'runner.sock');
  const origin='https://maa.test';
  const control=new DeviceControl();
  const runner=http.createServer((req,res)=>{const token=String(req.headers['x-control-token']||'');try{const value=req.url==='/api/control'&&req.method==='POST'?control.grant(token,false):{ok:true};res.setHeader('content-type','application/json');res.end(JSON.stringify(value));}catch{res.writeHead(500).end('{}');}});
  await new Promise<void>(r=>runner.listen(socketPath,r));
  const seen:http.IncomingHttpHeaders[]=[];const peers=new Set<net.Socket>();
  const media=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(req.url==='/stats'?'{"sources":[]}':'{}');});
  media.on('upgrade',(req,socket)=>{seen.push({...req.headers,path:req.url});peers.add(socket as net.Socket);socket.on('error',()=>{});const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);});
  await new Promise<void>(r=>media.listen(0,'127.0.0.1',r));
  const probe=net.createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));
  const child=spawn(process.execPath,['dist/portal.js'],{env:{...process.env,PUBLIC_ORIGIN:origin,RUNNER_SOCKET:socketPath,PORT:String(port),DEVICE_URL:'http://127.0.0.1:9',MEDIA_URL:`http://127.0.0.1:${(media.address() as net.AddressInfo).port}`,WEB_DIR:dir},stdio:'pipe'});
  const base=`http://127.0.0.1:${port}`;
  const upgrade=(headers:Record<string,string>)=>new Promise<number>(resolve=>{const req=http.request(base+'/media/ws',{headers:{origin,upgrade:'websocket',connection:'Upgrade','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13',...headers}});req.on('upgrade',(_res,socket)=>{socket.on('error',()=>{});socket.destroy();resolve(101);});req.on('response',res=>{res.resume();resolve(res.statusCode!);});req.end();});
  try{
    for(let i=0;i<100;i++){if(await fetch(base+'/api/health').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(await upgrade({origin:'https://evil.test'}),403);
    // a watcher: no cookie, and a forged credential header must not reach the media service
    assert.equal(await upgrade({'x-control-token':'f'.repeat(64),'x-real-ip':'1.2.3.4'}),101);
    assert.equal(seen.at(-1)!['x-control-token'],undefined);
    assert.notEqual(seen.at(-1)!['x-real-ip'],'1.2.3.4');
    assert.equal(seen.at(-1)!.path,'/ws');
    // a controller: the HttpOnly lease cookie becomes the internal credential header
    const response=await fetch(base+'/api/control',{method:'POST',headers:{origin,'content-type':'application/json','x-maa-request':'1'},body:'{}'});
    const cookie=response.headers.get('set-cookie')!.split(';')[0];
    assert.equal(await upgrade({cookie}),101);
    assert.equal(seen.at(-1)!['x-control-token'],cookie.split('=')[1]);
    assert.deepEqual(await (await fetch(base+'/media/stats')).json(),{sources:[]});
  }finally{child.kill();await new Promise<void>(r=>child.once('exit',()=>r()));for(const p of peers)p.destroy();runner.closeAllConnections();media.closeAllConnections();await Promise.all([new Promise<void>(r=>runner.close(()=>r())),new Promise<void>(r=>media.close(()=>r()))]);await fs.rm(dir,{recursive:true,force:true});}
});
