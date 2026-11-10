import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CoreLogIdentityProbe, coreLogPath, SwitchEvidence} from '../src/core-log-identity-probe';
import {executeSequence, MAX_IDENTITY_READBACKS} from '../src/sequence';
import type {IdentityProbe, IdentityStatus} from '../src/account-safety';
import {ACCOUNT_IDENTITY_MISMATCH_REASON} from '../src/account-safety';

// Shapes copied from a production MaaCore v6.21.4 asst.log, with the accounts replaced.
const TARGET = '111****1111', OTHER = '222****2222';
const enter = '[2026-11-07 19:00:11.379][TRC][Px1][Tx1] asst::AccountSwitchTask::_run | enter';
const proceed = (text: string) => `[2026-11-07 19:01:19.692][TRC][Px1][Tx1] Proceed [{ text: ${text}, rect: [ 506, 337, 112, 18 ], score: 0.993917 }]`;
const select = '[2026-11-08 03:11:40.508][TRC][Px1][Tx1] asst::AccountSwitchTask::select_account | enter';
const switched = (name: string) => `[2026-11-08 03:11:56.865][INF][Px1][Tx1] Assistant::append_callback | SubTaskExtraInfo {"class":"asst::AccountSwitchTask","details":{"account_name":"${name}"},"subtask":"AccountSwitchTask","taskchain":"StartUp","taskid":0,"uuid":"u","what":"AccountSwitch"}`;
const completed = '[2026-11-07 19:01:20.067][INF][Px1][Tx1] Assistant::append_callback | SubTaskCompleted {"class":"asst::AccountSwitchTask","details":{},"subtask":"AccountSwitchTask","taskchain":"StartUp","taskid":0,"uuid":"u"}';
const errored = '[2026-11-06 19:00:35.093][INF][Px1][Tx1] Assistant::append_callback | SubTaskError {"class":"asst::AccountSwitchTask","details":{},"subtask":"AccountSwitchTask","taskchain":"StartUp","taskid":0,"uuid":"u"}';
const alreadyCurrent = [enter, proceed('资源完整性'), proceed(TARGET), completed];
const selected = (name: string) => [enter, proceed(OTHER), select, proceed(name), switched(name), completed];

const classify = (lines: string[]) => {
  const evidence = new SwitchEvidence(TARGET);
  lines.forEach(line => evidence.feed(line));
  return evidence.status();
};

test('only the page already showing the target confirms; a performed switch does not', () => {
  assert.equal(classify(alreadyCurrent), 'confirmed');
  assert.equal(classify(selected(TARGET)), 'switched');
  assert.equal(classify(selected(OTHER)), 'mismatch');
});

test('anything short of a completed AccountSwitchTask is not evidence', () => {
  assert.equal(classify([]), 'unavailable');
  assert.equal(classify([proceed(TARGET), completed]), 'unavailable');
  assert.equal(classify([enter, proceed(TARGET)]), 'unavailable');
  assert.equal(classify([enter, proceed(TARGET), errored]), 'unavailable');
  assert.equal(classify([enter, proceed(OTHER), completed]), 'unavailable');
  // A target read after the task finished belongs to some other OCR.
  assert.equal(classify([enter, completed, proceed(TARGET)]), 'unavailable');
  // Selection that emitted no AccountSwitch never counts as the target being current.
  assert.equal(classify([enter, select, proceed(TARGET), completed]), 'unavailable');
});

test('the last attempt of the internally retried StartUp chain decides', () => {
  assert.equal(classify([enter, errored, ...alreadyCurrent]), 'confirmed');
  assert.equal(classify([...selected(TARGET), ...alreadyCurrent]), 'confirmed');
  assert.equal(classify([...alreadyCurrent, enter, errored]), 'unavailable');
});

test('the probe reads only what was written since begin(), across one rotation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-core-log-'));
  try {
    const log = path.join(dir, 'asst.log'), backup = path.join(dir, 'asst.bak.log');
    const probe = new CoreLogIdentityProbe(log);
    assert.equal(await probe.confirm({accountName: TARGET}), 'unavailable', 'no begin()');
    await probe.begin();
    assert.equal(await probe.confirm({accountName: TARGET}), 'unavailable', 'no log');

    await fs.writeFile(log, alreadyCurrent.join('\n') + '\n');
    await probe.begin();
    assert.equal(await probe.confirm({accountName: TARGET}), 'unavailable', 'earlier evidence is ignored');
    await fs.appendFile(log, selected(TARGET).join('\n') + '\n');
    assert.equal(await probe.confirm({accountName: TARGET}), 'switched');

    await probe.begin();
    await fs.appendFile(log, [enter, proceed(TARGET)].join('\n') + '\n');
    await fs.rename(log, backup);
    await fs.writeFile(log, completed + '\n');
    assert.equal(await probe.confirm({accountName: TARGET}), 'confirmed', 'rotation mid-task');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the log path follows the maa-cli state directory', () => {
  assert.equal(coreLogPath({XDG_STATE_HOME: '/data/state'}), path.join('/data/state', 'maa', 'debug', 'asst.log'));
  assert.equal(coreLogPath({HOME: '/home/u'}), path.join('/home/u', '.local', 'state', 'maa', 'debug', 'asst.log'));
});

/** Reports the scripted statuses in order, and counts how many StartUp windows were opened. */
function scripted(...statuses: IdentityStatus[]): IdentityProbe & {begun: number} {
  let index = 0;
  return {
    begun: 0,
    async begin() { this.begun++; },
    async confirm() { return statuses[index++] ?? 'unavailable'; },
  };
}
const startUp = ['-e', 'console.log("[2026-01-01 00:00:00 INFO ] StartUp Completed")'];
const second = ['-e', 'console.log("SECOND")'];
const target = {accountName: TARGET};
async function run(probe: IdentityProbe, policy?: 'warn-continue') {
  let output = '';
  const code = await executeSequence(process.execPath, [startUp, second], chunk => { output += chunk; }, {probe, target, identityPolicy: policy});
  return {code, output, startups: output.split('StartUp Completed').length - 1, ranSecond: output.includes('SECOND')};
}

test('a target that is already current runs the tasks with no extra StartUp', async () => {
  const probe = scripted('confirmed');
  const result = await run(probe);
  assert.deepEqual([result.code, result.startups, result.ranSecond, probe.begun], [0, 1, true, 1]);
  assert.match(result.output, /ACCOUNT_IDENTITY_CONFIRMED/);
  assert.doesNotMatch(result.output, /UNVERIFIED/);
});

test('a switch is read back before any task runs', async () => {
  const probe = scripted('switched', 'confirmed');
  const result = await run(probe);
  assert.deepEqual([result.code, result.startups, result.ranSecond, probe.begun], [0, 2, true, 2]);
  assert.ok(result.output.indexOf('ACCOUNT_SWITCH_READBACK') < result.output.indexOf('SECOND'));
});

test('a switch that does not take effect is retried, then blocked under every policy', async () => {
  const healed = await run(scripted('switched', 'switched', 'confirmed'));
  assert.deepEqual([healed.code, healed.startups, healed.ranSecond], [0, 3, true]);

  const statuses = Array<IdentityStatus>(MAX_IDENTITY_READBACKS + 1).fill('switched');
  for (const policy of [undefined, 'warn-continue'] as const) {
    const blocked = await run(scripted(...statuses), policy);
    assert.deepEqual([blocked.code, blocked.startups, blocked.ranSecond], [4, MAX_IDENTITY_READBACKS + 1, false]);
    assert.ok(blocked.output.includes(ACCOUNT_IDENTITY_MISMATCH_REASON));
  }
});

test('missing evidence blocks by default and only the explicit policy continues with the risk note', async () => {
  const blocked = await run(scripted('switched', 'unavailable'));
  assert.deepEqual([blocked.code, blocked.ranSecond], [3, false]);
  const continued = await run(scripted('unavailable'), 'warn-continue');
  assert.deepEqual([continued.code, continued.ranSecond], [0, true]);
  assert.match(continued.output, /ACCOUNT_IDENTITY_UNVERIFIED_COMPAT/);
});
