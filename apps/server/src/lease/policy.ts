import {WorkspaceError} from '../workspace/policy';

export const MANUAL_LEASE_MAX_MS = 15 * 60 * 1000;
export const MANUAL_LEASE_IDLE_MS = 2 * 60 * 1000;
export const AUTO_LEASE_MAX_MS = 2 * 60 * 60 * 1000;
export type LeaseKind = 'manual' | 'auto';
export type LeaseStatus = 'active' | 'expired' | 'revoked';

export type Lease = {
  id: string;
  ownerId: string;
  kind: LeaseKind;
  status: LeaseStatus;
  startedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
};

export function assertKind(kind: unknown): asserts kind is LeaseKind {
  if (kind !== 'manual' && kind !== 'auto') throw new WorkspaceError('Lease kind must be manual or auto');
}

export function toLease(row: any): Lease {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind as LeaseKind,
    status: row.status as LeaseStatus,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    revokedBy: row.revokedBy ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}
