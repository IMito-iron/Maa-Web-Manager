import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PrismaClient} from '@prisma/client';
import {PrismaLeaseRepository} from '../src/lease/repository';
import {LeaseService} from '../src/lease/service';
import {MANUAL_LEASE_IDLE_MS} from '../src/lease/policy';

test('lease exclusivity, gating, release, idle and deadline expiry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-lease-'));
  const file = path.join(dir, 'db.sqlite');
  await fs.writeFile(file, '');
  const url = 'file:' + file.replaceAll('\\', '/');
  const db = new PrismaClient({datasourceUrl: url});
  try {
    await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {env: {...process.env, DATABASE_URL: url}});
    const owner = await db.user.create({data: {username: 'owner', passwordHash: 'x'}});
    const other = await db.user.create({data: {username: 'other', passwordHash: 'x'}});
    const repo = new PrismaLeaseRepository(db);
    const locked = new LeaseService(repo, () => false);
    const open = new LeaseService(repo, () => true);

    // Manual lease is rejected until Device Owner / Lock Task acceptance.
    // Auto leases (internal task execution) are not confinement-gated.
    await assert.rejects(locked.grant(owner.id, 'manual'), /Device Owner/);
    const manual = await open.grant(owner.id, 'manual');
    assert.equal(manual.kind, 'manual');
    assert.equal(manual.status, 'active');

    // Exclusivity: a second grant fails regardless of owner.
    await assert.rejects(open.grant(other.id, 'manual'), /already active/);
    await assert.rejects(open.grant(owner.id, 'auto'), /already active/);

    // Status is visible to the owner and shows "busy" to others without leaking identity fields.
    const own = await open.status(owner.id);
    assert.equal(own.held.id, manual.id);
    const foreign = await open.status(other.id);
    assert.equal(foreign.busy, true);

    // Cross-user release is refused; the owner can release.
    await assert.rejects(open.release(other.id));
    const released = await open.release(owner.id);
    assert.equal(released.status, 'revoked');
    assert.equal((await open.status(owner.id)).held, null);

    // Idle timeout: a manual lease untouched past the idle window is swept.
    const idle = await open.grant(owner.id, 'manual');
    await repo.touch(idle.id, new Date(Date.now() - MANUAL_LEASE_IDLE_MS - 1000));
    await open.sweep();
    assert.equal(await repo.active(), null); // no active lease remains

    // Deadline timeout: an auto lease past expiresAt is swept.
    const auto = await open.grant(owner.id, 'auto');
    await db.deviceLease.update({where: {id: auto.id}, data: {expiresAt: new Date(Date.now() - 1000)}});
    await open.sweep();
    assert.equal(await repo.active(), null);

    // A fresh grant works again after sweep.
    const fresh = await open.grant(owner.id, 'manual');
    assert.equal(fresh.status, 'active');
  } finally {
    await db.$disconnect();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
