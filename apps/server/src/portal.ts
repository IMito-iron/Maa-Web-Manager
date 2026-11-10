import express from 'express';
import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {
  classifyApiUrl,
  isPublicApiUrl,
  publicMethodAllowed,
  PUBLIC_API_FORWARDED_RESPONSE_HEADERS,
  PUBLIC_API_GATEWAY_TIMEOUT,
  PUBLIC_API_METHOD_NOT_ALLOWED,
  PUBLIC_API_UPSTREAM_ERROR,
  PUBLIC_API_UPSTREAM_TIMEOUT_MS,
  type PublicApiEndpoint,
  publicOriginAllowed,
} from './portal-policy';
const origin=process.env.PUBLIC_ORIGIN;
const socketPath=process.env.RUNNER_SOCKET||'/control/control.sock';
const display=new URL(process.env.DEVICE_URL||'http://display-proxy:8080');
// Low-latency media service (WebRTC signalling + H.264 WebSocket fallback). Optional: when it is
// down, the Android page falls back to the noVNC compatibility mode.
const media=new URL(process.env.MEDIA_URL||'http://media:8090');
const cookieName='__Host-maa_control';
const credential=(req:http.IncomingMessage)=>{
  const value=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  return value&&/^[a-f0-9]{64}$/.test(value)?value:undefined;
};
async function main() {
  if(!publicOriginAllowed(origin))throw Error('PUBLIC_ORIGIN must be an https:// origin (http:// only for localhost/127.0.0.1)');
  const app=express();app.disable('x-powered-by');
  // The public Bot API has no request body, so body parsing must not turn a wrong method into a
  // parser error; the branch below owns its own JSON 405 answer.
  const jsonParser=express.json({limit:'1mb'});
  app.use((req,res,next)=>isPublicApiUrl(req.url)?next():jsonParser(req,res,next));
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    // Browser same-origin/JSON policy does not apply to the token-authenticated public API.
    if(isPublicApiUrl(req.url))return next();
    if(req.method==='OPTIONS'||(req.headers.origin&&req.headers.origin!==origin))return res.sendStatus(403);
    if(!['GET','HEAD'].includes(req.method)&&(req.headers.origin!==origin||req.headers['x-maa-request']!=='1'||!req.is('application/json')))return res.status(403).json({message:'Same-origin JSON request required'});
    next();
  });
  // Error answers added by the public branch carry the same no-store policy as the Manager.
  const publicError=(res:express.Response,status:number,body:unknown,headers:Record<string,string>={})=>
    res.status(status).set({'Cache-Control':'no-store','Pragma':'no-cache',...headers}).json(body);
  // The only branch that may reach the Manager without a control cookie: exact paths, GET/HEAD,
  // client Authorization forwarded verbatim, no `x-control-token` injection.
  const forwardPublicApi=(req:express.Request,res:express.Response,endpoint:PublicApiEndpoint)=>{
    if(!publicMethodAllowed(req.method))return publicError(res,405,PUBLIC_API_METHOD_NOT_ALLOWED,{Allow:'GET, HEAD'});
    const headers:Record<string,string>={};
    if(typeof req.headers.authorization==='string')headers.authorization=req.headers.authorization;
    let upstreamDone=false;
    const upstream=http.request({socketPath,path:req.originalUrl,method:req.method,headers},reply=>{
      upstreamDone=true;
      res.status(reply.statusCode||502);
      for(const name of PUBLIC_API_FORWARDED_RESPONSE_HEADERS){const value=reply.headers[name];if(value)res.setHeader(name,String(value));}
      reply.pipe(res);
    });
    upstream.setTimeout(PUBLIC_API_UPSTREAM_TIMEOUT_MS,()=>{
      upstream.destroy();
      if(upstreamDone){if(!res.writableEnded)res.destroy();return;}
      upstreamDone=true;
      if(!res.headersSent)publicError(res,504,PUBLIC_API_GATEWAY_TIMEOUT);else res.destroy();
    });
    upstream.on('error',()=>{
      if(upstreamDone){if(!res.writableEnded)res.destroy();return;}
      upstreamDone=true;
      if(!res.headersSent)publicError(res,502,PUBLIC_API_UPSTREAM_ERROR);else res.destroy();
    });
    res.on('close',()=>upstream.destroy());
    upstream.end();
  };
  app.use('/api',(req,res)=>{
    const policy=classifyApiUrl(req.originalUrl);
    if(policy.kind==='public')return forwardPublicApi(req,res,policy.endpoint);
    // `control` covers the lease endpoints (acquire/release/heartbeat/screen-off); the retired
    // account and runner APIs are still refused.
    if(policy.kind==='retired')return res.status(410).json({message:'This API has been retired; use shared presets and /api/control'});
    let token=credential(req);
    if(req.path==='/control'&&req.method==='POST'&&!token){token=randomBytes(32).toString('hex');res.cookie(cookieName,token,{httpOnly:true,secure:true,sameSite:'strict',path:'/'});}
    const payload=['GET','HEAD'].includes(req.method)?undefined:JSON.stringify(req.body||{});
    const upstream=http.request({socketPath,path:req.originalUrl,method:req.method,headers:{origin,'content-type':'application/json','x-maa-request':'1',...(payload?{'content-length':Buffer.byteLength(payload)}:{}),...(token?{'x-control-token':token}:{}),...(req.headers['last-event-id']?{'last-event-id':String(req.headers['last-event-id'])}:{})}},reply=>{
      res.status(reply.statusCode||502);for(const name of ['content-type','cache-control','x-accel-buffering'])if(reply.headers[name])res.setHeader(name,reply.headers[name]!);reply.pipe(res);
    });
    upstream.on('error',()=>{if(!res.headersSent)res.status(502).json({message:'Runner unavailable'});else res.destroy();});res.on('close',()=>upstream.destroy());
    upstream.end(payload);
  });
  // Media statistics are read-only; watching needs no lease.
  app.get('/media/stats',(_req,res)=>{
    const upstream=http.request({hostname:media.hostname,port:media.port||80,path:'/stats',method:'GET',timeout:3000},reply=>{
      res.status(reply.statusCode||502);res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');reply.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent)res.status(502).json({message:'Media service unavailable'});else res.destroy();});res.on('close',()=>upstream.destroy());upstream.end();
  });
  const landing='/vnc/vnc.html?autoconnect=1&resize=scale&path=%2Fvnc%2Fwebsockify';
  app.get('/vnc',(_req,res)=>res.redirect(landing));
  app.use('/vnc',(req,res)=>{
    if(!['GET','HEAD'].includes(req.method))return res.sendStatus(405);
    if(req.path==='/')return res.redirect(landing);
    // Express already stripped /vnc; static resources do not require control.
    const upstream=http.request({hostname:display.hostname,port:display.port||80,path:req.url,method:req.method},reply=>{
      res.status(reply.statusCode||502);for(const name of ['content-type','content-length'])if(reply.headers[name])res.setHeader(name,reply.headers[name]!);reply.pipe(res);
    });
    upstream.on('error',()=>{if(!res.headersSent)res.status(502).send('Display unavailable');else res.destroy();});res.on('close',()=>upstream.destroy());upstream.end();
  });
  const web=process.env.WEB_DIR||'/app/apps/web/dist';app.use(express.static(web));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(web,'index.html')));
  const server=http.createServer(app),connections=new Set<()=>void>();
  server.on('upgrade',(req,socket,head)=>{void(async()=>{
    // View mode is always available (NPM already authenticates at the gateway);
    // input is gated device-side via x11vnc read-only, toggled by the control lease.
    if(req.headers.origin!==origin||(req.url!=='/vnc/websockify'&&req.url!=='/media/ws')){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    // The media socket: watching is open to every admitted visitor; the lease credential is passed
    // on so the media service can check control with the Manager itself. Only this header set is
    // sent upstream, so a browser cannot forge X-Control-Token or X-Real-IP.
    const isMedia=req.url==='/media/ws';
    const target=isMedia?media:display;
    const token=isMedia?credential(req):undefined;
    const forwarded=typeof req.headers['x-forwarded-for']==='string'?req.headers['x-forwarded-for'].split(',')[0].trim():req.socket.remoteAddress||'';
    let remote:import('node:stream').Duplex|undefined,closed=false;
    const close=()=>{if(closed)return;closed=true;socket.destroy();remote?.destroy();upstream.destroy();connections.delete(close);};
    const upstream=http.request({hostname:target.hostname,port:target.port||80,path:isMedia?'/ws':'/websockify',headers:{upgrade:'websocket',connection:'Upgrade','sec-websocket-key':req.headers['sec-websocket-key']!,'sec-websocket-version':'13',...(req.headers['sec-websocket-protocol']?{'sec-websocket-protocol':req.headers['sec-websocket-protocol']}: {}),...(isMedia?{'x-real-ip':forwarded.slice(0,64),...(token?{'x-control-token':token}:{})}:{})}});
    connections.add(close);socket.on('close',close);socket.on('error',close);upstream.setTimeout(5000,close);upstream.on('error',close);upstream.on('response',close);
    upstream.on('upgrade',(reply,peer,initial)=>{
      remote=peer;peer.on('error',close);peer.on('close',close);
      // Long-lived and latency-sensitive (touch input): no idle timeout, no Nagle batching.
      if(isMedia){peer.setTimeout(0);(peer as import('node:net').Socket).setNoDelay?.(true);(socket as import('node:net').Socket).setNoDelay?.(true);}
      const headers=['Upgrade: websocket','Connection: Upgrade',`Sec-WebSocket-Accept: ${reply.headers['sec-websocket-accept']}`];
      if(reply.headers['sec-websocket-protocol'])headers.push(`Sec-WebSocket-Protocol: ${reply.headers['sec-websocket-protocol']}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if(initial.length)socket.write(initial);if(head.length)peer.write(head);peer.pipe(socket);socket.pipe(peer);
    });upstream.end();
  })().catch(()=>socket.destroy());});
  server.listen(Number(process.env.PORT||3000),'0.0.0.0');
  process.on('SIGTERM',()=>{for(const close of connections)close();server.closeAllConnections();server.close(()=>process.exit(0));});
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
