import {Express} from 'express';
import {LeaseService} from './service';

export function installLeaseRoutes(app: Express, service: LeaseService) {
  app.get('/api/lease', async (_req, res) => res.json(await service.status(res.locals.session.user.id)));
  // Users may only request manual (remote-control) leases; auto leases are reserved
  // for the system's own task execution and are never exposed through the public API.
  app.post('/api/lease', async (_req, res) => {
    res.status(201).json(await service.grant(res.locals.session.user.id, 'manual'));
  });
  app.delete('/api/lease', async (req, res) => res.json(await service.release(res.locals.session.user.id)));
}
