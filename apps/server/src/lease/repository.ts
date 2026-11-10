import {PrismaClient} from '@prisma/client';
import {serialTransaction} from '../transaction';
import {WorkspaceError} from '../workspace/policy';
import {Lease, LeaseKind, MANUAL_LEASE_IDLE_MS, toLease} from './policy';

export interface LeaseRepository {
  /** The single active (non-expired, non-idle) lease, or null. */
  active(now?: Date): Promise<Lease | null>;
  /** Atomically check exclusivity and create an active lease. */
  grant(ownerId: string, kind: LeaseKind, expiresAt: Date): Promise<Lease>;
  touch(id: string, at: Date): Promise<void>;
  revoke(id: string, by: string | null, at: Date): Promise<Lease | null>;
  /** Mark leases expired by wall-clock deadline or manual idle timeout. */
  expire(now: Date): Promise<number>;
}

export class PrismaLeaseRepository implements LeaseRepository {
  constructor(private db: PrismaClient) {}
  async active(now = new Date()) {
    const row = await this.db.deviceLease.findFirst({
      where: {status: 'active', expiresAt: {gt: now}},
      orderBy: {startedAt: 'desc'},
    });
    return row ? toLease(row) : null;
  }
  async grant(ownerId: string, kind: LeaseKind, expiresAt: Date) {
    return serialTransaction(this.db, async tx => {
      const existing = await tx.deviceLease.findFirst({where: {status: 'active', expiresAt: {gt: new Date()}}});
      if (existing) throw new WorkspaceError('Another device lease is already active', 409);
      const row = await tx.deviceLease.create({data: {ownerId, kind, status: 'active', expiresAt, lastSeenAt: new Date()}});
      return toLease(row);
    });
  }
  async touch(id: string, at: Date) {
    await this.db.deviceLease.updateMany({where: {id, status: 'active'}, data: {lastSeenAt: at}});
  }
  async revoke(id: string, by: string | null, at: Date) {
    const result = await this.db.deviceLease.updateMany({where: {id, status: 'active'}, data: {status: 'revoked', revokedBy: by, revokedAt: at}});
    if (result.count !== 1) return null;
    return toLease((await this.db.deviceLease.findUniqueOrThrow({where: {id}})));
  }
  async expire(now: Date) {
    const idleCutoff = new Date(now.getTime() - MANUAL_LEASE_IDLE_MS);
    const byDeadline = await this.db.deviceLease.updateMany({where: {status: 'active', expiresAt: {lte: now}}, data: {status: 'expired'}});
    const byIdle = await this.db.deviceLease.updateMany({where: {status: 'active', kind: 'manual', lastSeenAt: {lte: idleCutoff}}, data: {status: 'expired'}});
    return byDeadline.count + byIdle.count;
  }
}
