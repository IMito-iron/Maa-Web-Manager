import {WorkspaceError} from '../workspace/policy';
import {assertKind, AUTO_LEASE_MAX_MS, Lease, LeaseKind, MANUAL_LEASE_MAX_MS} from './policy';
import {LeaseRepository} from './repository';

export class LeaseService {
  constructor(private repo: LeaseRepository, private confinementVerified: () => boolean = () => false) {}
  async grant(ownerId: string, kind: LeaseKind) {
    assertKind(kind);
    if (kind === 'manual' && !this.confinementVerified()) {
      throw new WorkspaceError('Device Owner / Lock Task acceptance is required before remote control', 403);
    }
    const maxMs = kind === 'manual' ? MANUAL_LEASE_MAX_MS : AUTO_LEASE_MAX_MS;
    return this.repo.grant(ownerId, kind, new Date(Date.now() + maxMs));
  }
  async status(ownerId: string) {
    const active = await this.repo.active();
    if (!active) return {held: null};
    if (active.ownerId === ownerId) return {held: active};
    // Do not leak the holder's identity; only reveal that the device is busy.
    return {held: {kind: active.kind, ownerId: active.ownerId}, busy: true};
  }
  async release(ownerId: string) {
    const active = await this.repo.active();
    if (!active || active.ownerId !== ownerId) throw new WorkspaceError('No active lease for this user', 404);
    return this.repo.revoke(active.id, ownerId, new Date());
  }
  async ownsActive(ownerId: string, kind?: LeaseKind): Promise<Lease | null> {
    const active = await this.repo.active();
    if (!active || active.ownerId !== ownerId) return null;
    if (kind && active.kind !== kind) return null;
    return active;
  }
  async touch(ownerId: string, id: string) {
    const active = await this.repo.active();
    if (!active || active.id !== id || active.ownerId !== ownerId) return;
    await this.repo.touch(id, new Date());
  }
  async sweep() {
    return this.repo.expire(new Date());
  }
}
