import {Express} from 'express';
import {WorkspaceService} from './service';
export function installWorkspaceRoutes(app:Express,service:WorkspaceService) {
  app.get('/api/game-accounts',async(_req,res)=>res.json(await service.accounts(res.locals.session.user.id)));
  app.post('/api/game-accounts',async(req,res)=>res.status(201).json(await service.createAccount(res.locals.session.user.id,req.body)));
  app.get('/api/my/tasks',async(_req,res)=>res.json(await service.tasks(res.locals.session.user.id)));
  app.post('/api/my/tasks',async(req,res)=>res.status(201).json(await service.save(res.locals.session.user.id,req.body)));
  app.get('/api/my/tasks/:id',async(req,res)=>res.json(await service.task(res.locals.session.user.id,req.params.id)));
  app.put('/api/my/tasks/:id',async(req,res)=>res.json(await service.save(res.locals.session.user.id,req.body,req.params.id)));
  app.delete('/api/my/tasks/:id',async(req,res)=>res.json(await service.remove(res.locals.session.user.id,req.params.id,req.body?.version)));
}
