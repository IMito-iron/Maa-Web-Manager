import {Express} from 'express';
import http from 'node:http';
import {PrismaClient} from '@prisma/client';
import {randomBytes} from 'node:crypto';
import {AuthService,AuthError,credentials,tokenDigest} from './service';
import {PasswordHasher} from './password';
const cookieName='__Host-maa_session';
export const token=(req:http.IncomingMessage)=>req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
const cookie=(value:string,age=43200)=>`${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

export function installAuthRoutes(app:Express,db:PrismaClient,auth:AuthService,passwords:PasswordHasher,origin:string) {
  const attempts=new Map<string,{count:number;until:number}>();
  function limit(key:string) {
    const now=Date.now();
    for(const [k,v] of attempts) if(v.until<=now)attempts.delete(k);
    const value=attempts.get(key)||{count:0,until:now+15*60000};
    if(attempts.size>=10000||++value.count>10)throw new AuthError('Too many attempts; try again later');
    attempts.set(key,value);
  }
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-store'});
    if(req.method==='OPTIONS')return res.sendStatus(403);
    if(!['GET','HEAD'].includes(req.method)&&(req.headers.origin!==origin||req.headers['x-maa-request']!=='1'||!req.is('application/json')))return res.status(403).json({message:'Same-origin JSON required'});
    next();
  });
  app.get('/api/health',(_req,res)=>res.json({ok:true}));
  app.post('/api/auth/login',async(req,res)=>{
    limit('ip:'+req.socket.remoteAddress);limit('user:'+String(req.body?.username).slice(0,32));
    const session=await auth.login(req.body?.username,req.body?.password);
    await db.auditEvent.create({data:{actorId:session.user.id,action:'login'}});
    res.setHeader('Set-Cookie',cookie(session.token));res.json({user:session.user,csrf:session.csrf});
  });
  app.post('/api/auth/register',async(req,res)=>{
    limit('register:'+req.socket.remoteAddress);
    const {username,password,invitation}=req.body||{};credentials(username,password);
    if(typeof invitation!=='string'||!/^[a-f0-9]{64}$/.test(invitation))throw new AuthError('Invalid invitation');
    const passwordHash=await passwords.hash(password);
    await db.$transaction(async tx=>{
      const used=await tx.invitation.updateMany({where:{digest:tokenDigest(invitation),usedAt:null,expiresAt:{gt:new Date()}},data:{usedAt:new Date()}});
      if(used.count!==1)throw new AuthError('Invalid invitation');
      const user=await tx.user.create({data:{username,passwordHash}});
      await tx.auditEvent.create({data:{actorId:user.id,action:'register'}});
    });
    res.status(201).json({ok:true});
  });
  app.use('/api',async(req,res,next)=>{
    const session=await auth.authenticate(token(req),!req.path.endsWith('/events'));
    if(!session)return res.status(401).json({message:'Login required'});
    res.locals.session=session;
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==session.csrf)return res.status(403).json({message:'Invalid CSRF token'});
    next();
  });
  app.get('/api/auth/me',(_req,res)=>{const s=res.locals.session;res.json({user:{id:s.user.id,username:s.user.username,role:s.user.role},csrf:s.csrf});});
  app.post('/api/auth/logout',async(req,res)=>{await auth.logout(token(req)!);res.setHeader('Set-Cookie',cookie('',0));res.json({ok:true});});
  app.post('/api/auth/logout-all',async(_req,res)=>{await db.session.deleteMany({where:{userId:res.locals.session.user.id}});res.setHeader('Set-Cookie',cookie('',0));res.json({ok:true});});
  app.post('/api/auth/password',async(req,res)=>{
    const user=await db.user.findUniqueOrThrow({where:{id:res.locals.session.user.id}});
    limit('password:'+user.id);
    if(typeof req.body?.currentPassword!=='string'||req.body.currentPassword.length>128||!(await passwords.verify(user.passwordHash,req.body.currentPassword)))throw new AuthError('Invalid credentials');
    credentials(user.username,req.body?.password);
    const passwordHash=await passwords.hash(req.body.password);
    await db.$transaction([db.user.update({where:{id:user.id},data:{passwordHash}}),db.session.deleteMany({where:{userId:user.id}}),db.auditEvent.create({data:{actorId:user.id,action:'password-change'}})]);
    res.setHeader('Set-Cookie',cookie('',0));res.json({ok:true});
  });
  app.use('/api/admin',(_req,res,next)=>res.locals.session.user.role==='admin'?next():res.status(403).json({message:'Administrator required'}));
  app.get('/api/admin/users',async(_req,res)=>res.json(await db.user.findMany({select:{id:true,username:true,role:true,disabled:true,createdAt:true}})));
  app.post('/api/admin/invitations',async(_req,res)=>{
    await db.invitation.deleteMany({where:{expiresAt:{lt:new Date()}}});
    if(await db.invitation.count({where:{usedAt:null}})>=20)throw new AuthError('Too many unused invitations');
    const invitation=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+86400000);
    await db.invitation.create({data:{digest:tokenDigest(invitation),expiresAt,createdBy:res.locals.session.user.id}});
    await db.auditEvent.create({data:{actorId:res.locals.session.user.id,action:'invite'}});
    res.status(201).json({invitation,expiresAt});
  });
  app.post('/api/admin/users/:id/disable',async(req,res)=>{
    if(req.params.id===res.locals.session.user.id)throw new AuthError('Cannot disable yourself');
    if(typeof req.body?.disabled!=='boolean')throw new AuthError('Boolean disabled required');
    await db.$transaction([db.user.update({where:{id:req.params.id},data:{disabled:req.body.disabled}}),db.session.deleteMany({where:{userId:req.params.id}}),db.auditEvent.create({data:{actorId:res.locals.session.user.id,action:req.body.disabled?'disable-user':'enable-user',targetId:req.params.id}})]);
    res.json({ok:true});
  });
  app.get('/api/admin/audit',async(_req,res)=>res.json(await db.auditEvent.findMany({orderBy:{createdAt:'desc'},take:100})));

}
