import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_IDENTITY_MISMATCH_REASON, ACCOUNT_IDENTITY_UNVERIFIED_REASON, ACCOUNT_IDENTITY_UNVERIFIED_COMPAT_REASON,
  ACCOUNT_STARTUP_CONDITIONAL_REASON, ACCOUNT_STARTUP_DISABLED_REASON, analyzePresetAccount, accountIdentityReason,
  identityBlockReason, identityPolicyNote, isNeverCondition, normalizeExecutionDocument, parseAccountIdentityPolicy,
  taskState, UnavailableIdentityProbe,
} from '../src/account-safety';
import {executionPlan} from '../src/execution-plan';
import {executeSequence} from '../src/sequence';
import {Engine} from '../src/engine';
import {cfg} from '../src/config';

const never = {type: 'Not', condition: {type: 'Always'}};
const startup = (params: any = {}, extra: any = {}) => ({name: 'start', type: 'StartUp', params, ...extra});
const fight = {name: 'fight', type: 'Fight', params: {stage: '1-7', times: 1}};

test('native task activity mirrors maa-cli: absent variants, never-conditions and enable=false', () => {
  assert.equal(taskState({type: 'Fight', params: {}}), 'active');
  assert.equal(taskState({type: 'Fight', params: {enable: false}}), 'disabled');
  assert.equal(taskState({type: 'Fight', params: {}, variants: [{condition: never}]}), 'disabled');
  assert.equal(taskState({type: 'Fight', params: {}, variants: [{condition: {type: 'Or', conditions: []}}]}), 'disabled');
  assert.equal(taskState({type: 'Fight', params: {}, variants: [{condition: {type: 'Always'}}]}), 'conditional');
  assert.equal(taskState({type: 'Fight', params: {}, variants: [{condition: never}, {condition: {type: 'Time'}}]}), 'conditional');
  assert.equal(isNeverCondition({type: 'Not', condition: {type: 'Always'}}), true);
  assert.equal(isNeverCondition({type: 'And', conditions: []}), false);
});

test('ordinary single-account presets are unchanged and never identity-gated', () => {
  const doc = {startup: true, tasks: [startup({client_type: 'Official'}), fight]};
  const plan = analyzePresetAccount(doc);
  assert.equal(plan.switchRequested, false);
  assert.equal(plan.identityRequired, false);
  assert.equal(plan.block, undefined);
  const normalized = normalizeExecutionDocument(doc);
  assert.equal(normalized.changed, false);
  assert.deepEqual(normalized.document, doc);
  assert.equal(executionPlan(JSON.stringify(doc)).normalized, false);
});

test('an empty account_name does not request a switch', () => {
  for (const account_name of ['', '   ', null, undefined]) {
    const plan = analyzePresetAccount({tasks: [startup({account_name})]});
    assert.equal(plan.switchRequested, false, String(account_name));
  }
  assert.equal(analyzePresetAccount({tasks: [startup({account_name: 'remembered'})]}).switchRequested, true);
});

test('account presets require an active unconditional first StartUp', () => {
  const active = analyzePresetAccount({tasks: [startup({account_name: 'remembered'}), fight]});
  assert.equal(active.switchRequested, true);
  assert.equal(active.identityRequired, true);
  assert.equal(active.startupState, 'active');
  assert.equal(active.block, undefined);
  const activePlan = executionPlan(JSON.stringify({tasks: [startup({account_name: 'remembered'}), fight]}));
  assert.equal(activePlan.switching, true);

  const disabled = analyzePresetAccount({tasks: [startup({account_name: 'remembered'}, {variants: [{condition: never}]}), fight]});
  assert.equal(disabled.startupState, 'disabled');
  assert.equal(disabled.block?.code, 'ACCOUNT_STARTUP_DISABLED');
  assert.equal(disabled.block?.message, ACCOUNT_STARTUP_DISABLED_REASON);
  assert.throws(() => executionPlan(JSON.stringify({tasks: [startup({account_name: 'remembered'}, {variants: [{condition: never}]}), fight]})), /ACCOUNT_STARTUP_DISABLED/);

  const conditional = analyzePresetAccount({tasks: [startup({account_name: 'remembered'}, {variants: [{condition: {type: 'Weekday', weekdays: ['Mon']}}]}), fight]});
  assert.equal(conditional.block?.code, 'ACCOUNT_STARTUP_CONDITIONAL');
  assert.throws(() => executionPlan(JSON.stringify({tasks: [startup({account_name: 'remembered'}, {condition: {type: 'Time'}}), fight]})));

  const enableFalse = analyzePresetAccount({tasks: [startup({account_name: 'remembered', enable: false}), fight]});
  assert.equal(enableFalse.block?.code, 'ACCOUNT_STARTUP_DISABLED');

  for (const tasks of [
    [fight, startup({account_name: 'remembered'})],
    [startup({account_name: 'remembered'}), startup({account_name: 'second'})],
    [startup({account_name: 'remembered'}), {type: 'Fight', variants: [{params: {account_name: 'nested'}}]}],
  ]) assert.notEqual(analyzePresetAccount({tasks}).block, undefined, JSON.stringify(tasks));
  assert.equal(analyzePresetAccount({tasks: [startup({account_name: 'remembered', enable: false}), fight]}).block?.message, ACCOUNT_STARTUP_DISABLED_REASON);
  assert.equal(analyzePresetAccount({tasks: [startup({account_name: 'remembered'}, {condition: {type: 'Time'}}), fight]}).block?.message, ACCOUNT_STARTUP_CONDITIONAL_REASON);
});

test('disabling StartUp suppresses the preset-level implicit startup, keeping every parameter', () => {
  const doc = {name: 'daily', client_type: 'Official', startup: true, closedown: false, future: {x: 1},
    tasks: [startup({client_type: 'YoStarJP', start_game_enabled: true, enable: true, future: {n: null}}, {variants: [{condition: never}]}), fight]};
  const original = structuredClone(doc);
  const normalized = normalizeExecutionDocument(doc);
  assert.equal(normalized.changed, true);
  assert.equal(normalized.document.startup, false);
  assert.deepEqual(normalized.document.tasks, original.tasks);
  assert.deepEqual(normalized.document.future, original.future);
  assert.equal(normalized.document.closedown, false);
  assert.deepEqual(doc, original, 'the stored preset is never mutated');
  // Only the single flag differs.
  const diff = Object.keys(normalized.document).filter(key => JSON.stringify(normalized.document[key]) !== JSON.stringify(original[key]));
  assert.deepEqual(diff, ['startup']);
  // The execution snapshot is what the run records and hands to maa-cli.
  const plan = executionPlan(JSON.stringify(doc));
  assert.equal(plan.normalized, true);
  assert.equal(plan.switching, false);
  assert.equal(plan.documents[0].startup, false);
  assert.deepEqual(plan.documents[0].tasks, original.tasks);
});

test('presets with an active StartUp, or with no StartUp but startup=true, keep their implicit-StartUp semantics', () => {
  const active = {startup: true, tasks: [startup({}), fight]};
  assert.equal(normalizeExecutionDocument(active).changed, false);
  const implicit = {startup: true, tasks: [fight]};
  assert.deepEqual(normalizeExecutionDocument(implicit), {document: implicit, changed: false});
  const explicitFalse = {startup: false, tasks: [startup({}, {variants: [{condition: never}]}), fight]};
  assert.equal(normalizeExecutionDocument(explicitFalse).changed, false);
  const conditional = {startup: true, tasks: [startup({}, {variants: [{condition: {type: 'Time'}}]}), fight]};
  assert.equal(normalizeExecutionDocument(conditional).changed, false);
});

test('identity decisions map to stable fail-closed reasons and the default probe never confirms', async () => {
  assert.equal(identityBlockReason('confirmed'), null);
  assert.equal(identityBlockReason('unavailable'), ACCOUNT_IDENTITY_UNVERIFIED_REASON);
  assert.equal(identityBlockReason('mismatch'), ACCOUNT_IDENTITY_MISMATCH_REASON);
  assert.equal(accountIdentityReason(false, 3), null);
  assert.equal(accountIdentityReason(true, 3), ACCOUNT_IDENTITY_UNVERIFIED_REASON);
  assert.equal(accountIdentityReason(true, 4), ACCOUNT_IDENTITY_MISMATCH_REASON);
  assert.equal(accountIdentityReason(true, 0), null);
  assert.equal(await new UnavailableIdentityProbe().confirm({accountName: 'remembered'}), 'unavailable');
});

test('the explicit compatibility policy only relaxes completed-but-unverified, never a mismatch', () => {
  assert.equal(parseAccountIdentityPolicy('warn-continue'), 'warn-continue');
  assert.equal(parseAccountIdentityPolicy('require-verified'), 'require-verified');
  assert.equal(parseAccountIdentityPolicy('anything-else'), 'require-verified');
  assert.equal(parseAccountIdentityPolicy(undefined), 'require-verified');
  assert.equal(identityBlockReason('unavailable', 'require-verified'), ACCOUNT_IDENTITY_UNVERIFIED_REASON);
  assert.equal(identityBlockReason('unavailable', 'warn-continue'), null);
  assert.equal(identityBlockReason('mismatch', 'warn-continue'), ACCOUNT_IDENTITY_MISMATCH_REASON);
  assert.equal(identityBlockReason('confirmed', 'warn-continue'), null);
  assert.equal(identityPolicyNote('warn-continue'), ACCOUNT_IDENTITY_UNVERIFIED_COMPAT_REASON);
  assert.equal(identityPolicyNote('require-verified'), null);
});

test('switch completion alone never lets account-scoped tasks run; only a positive probe does', async () => {
  const completed = ['-e', 'console.log("[INFO] StartUp Completed")'];
  // No probe: the documented production boundary today.
  let output = '';
  assert.equal(await executeSequence(process.execPath, [completed, ['-e', 'console.log("SECOND")']], c => { output += c; }), 3);
  assert.doesNotMatch(output, /SECOND/);
  assert.match(output, /ACCOUNT_IDENTITY_UNVERIFIED/);
  // Probe says a different account is logged in.
  output = '';
  assert.equal(await executeSequence(process.execPath, [completed, ['-e', 'console.log("SECOND")']], c => { output += c; },
    {probe: {confirm: async () => 'mismatch'}, target: {accountName: 'remembered'}}), 4);
  assert.doesNotMatch(output, /SECOND/);
  assert.match(output, /ACCOUNT_IDENTITY_MISMATCH/);
  // Probe positively confirms the target: the remaining tasks are allowed to run.
  output = '';
  assert.equal(await executeSequence(process.execPath, [completed, ['-e', 'console.log("SECOND")']], c => { output += c; },
    {probe: {confirm: async () => 'confirmed'}, target: {accountName: 'remembered'}}), 0);
  assert.match(output, /SECOND/);
  // A StartUp that fails or never reports completion still stops before identity is asked.
  for (const script of ['process.exit(7)', 'console.log("[INFO] StartUp Stopped")']) {
    let calls = 0, blocked = false;
    assert.notEqual(await executeSequence(process.execPath, [['-e', script], ['-e', 'console.log("SECOND")']], c => { blocked ||= /SECOND/.test(String(c)); },
      {probe: {confirm: async () => { calls++; return 'confirmed'; }}, target: {accountName: 'remembered'}}), 0);
    assert.equal(calls, 0);
    assert.equal(blocked, false);
  }
});

test('compatibility mode continues after a completed StartUp but never claims identity', async () => {
  let output = '';
  const code = await executeSequence(process.execPath,
    [['-e', 'console.log("[INFO] StartUp Completed")'], ['-e', 'console.log("SECOND")']],
    c => { output += c; }, {probe: {confirm: async () => 'unavailable'}, target: {accountName: 'remembered'}, identityPolicy: 'warn-continue'});
  assert.equal(code, 0);
  assert.match(output, /SECOND/);
  assert.match(output, /ACCOUNT_IDENTITY_UNVERIFIED_COMPAT/);
  // A mismatch is still blocked even in compatibility mode.
  let blocked = '';
  assert.equal(await executeSequence(process.execPath,
    [['-e', 'console.log("[INFO] StartUp Completed")'], ['-e', 'console.log("SECOND")']],
    c => { blocked += c; }, {probe: {confirm: async () => 'mismatch'}, target: {accountName: 'remembered'}, identityPolicy: 'warn-continue'}), 4);
  assert.doesNotMatch(blocked, /SECOND/);
});

test('a confirmed identity releases the remaining tasks, whose own failure is an ordinary failure', async () => {
  let output = '';
  const code = await executeSequence(process.execPath,
    [['-e', 'console.log("[INFO] StartUp Completed")'], ['-e', 'console.log("SECOND");process.exit(7)']],
    c => { output += c; }, {probe: {confirm: async () => 'confirmed'}, target: {accountName: 'remembered'}});
  assert.equal(code, 7);
  assert.match(output, /SECOND/);
});

test('Engine executes a normalised snapshot file for a disabled StartUp and an unchanged snapshot otherwise', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-startup-optional-'));
  const previous = {data: cfg.data, tasks: cfg.tasks, maa: cfg.maa}, oldOptions = process.env.NODE_OPTIONS,
    oldCapture = process.env.FAKE_CAPTURE, oldTasks = process.env.FAKE_TASKS_DIR, oldExit = process.env.FAKE_EXIT;
  const preload = path.join(directory, 'fake-maa.cjs'), capture = path.join(directory, 'capture.jsonl');
  cfg.data = directory; cfg.tasks = path.join(directory, 'tasks'); cfg.maa = process.execPath;
  await Promise.all(['logs', 'executions', 'tasks'].map(name => fs.mkdir(path.join(directory, name))));
  await fs.writeFile(preload, `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(1);`
    + `if(a.some(x=>String(x).endsWith('sequence-main.js')))return;`
    + `const substituted=String(a[1]||'').includes('executions');`
    + `const document=substituted?JSON.parse(fs.readFileSync(a[1],'utf8')):null;`
    + `fs.appendFileSync(process.env.FAKE_CAPTURE,JSON.stringify({argv:a,document})+'\\n');`
    + `console.log('[INFO] StartUp Completed');process.exit(Number(process.env.FAKE_EXIT||0));`);
  process.env.NODE_OPTIONS = '--require=' + JSON.stringify(preload);
  process.env.FAKE_CAPTURE = capture; process.env.FAKE_TASKS_DIR = cfg.tasks;
  const updates: any[] = [];
  const store: any = {serial: async (f: any) => f(), db: {run: {update: async (v: any) => updates.push(v.data), findFirst: async () => null, create: async () => {}}}};
  const engine: any = new Engine(store, {binding: async () => ({address: 'FAKE-USB'}), prepare: async () => {}} as any,
    {get: async () => ({stage: null, learnedAt: null}), learn: async () => {throw Error('unexpected learning');}});
  engine.signal = () => {};
  const awaitFinish = async () => {for (let i = 0; i < 300; i++) {if (!engine.current) return; await new Promise(r => setTimeout(r, 10));} throw Error('Fake child did not finalize');};
  try {
    const disabled = {startup: true, tasks: [startup({client_type: 'YoStarJP', start_game_enabled: true, future: 1}, {variants: [{condition: never}]}), fight]};
    await fs.writeFile(path.join(cfg.tasks, 'disabled.json'), JSON.stringify(disabled));
    await engine.start({id: '00000000-0000-4000-8000-000000000011', task: 'disabled', hash: 'synthetic', snapshot: JSON.stringify(disabled), source: 'manual'});
    await awaitFinish();
    const first = JSON.parse((await fs.readFile(capture, 'utf8')).trim().split('\n')[0]);
    assert.equal(path.resolve(first.argv[0]), path.resolve('run'));
    assert.equal(path.dirname(first.argv[1]), path.join(directory, 'executions'));
    assert.equal(path.extname(first.argv[1]), '.json');
    assert.deepEqual(first.argv.slice(2), ['--addr', 'FAKE-USB', '--batch', '-v']);
    assert.equal(first.document.startup, false, 'implicit maa-cli StartUp is suppressed');
    assert.deepEqual(first.document.tasks, disabled.tasks, 'disabled StartUp and all parameters are preserved');
    assert.equal(updates.at(-1).status, 'success');

    const active = {startup: true, tasks: [startup({}), fight]};
    await fs.writeFile(path.join(cfg.tasks, 'active.json'), JSON.stringify(active));
    await engine.start({id: '00000000-0000-4000-8000-000000000012', task: 'active', hash: 'synthetic', snapshot: JSON.stringify(active), source: 'manual'});
    await awaitFinish();
    const lines = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const second = lines.at(-1);
    // WIN-PARITY: every run executes a private snapshot (GUI tasks are compiled at dispatch); for a
    // raw preset that snapshot is byte-for-byte the stored document.
    assert.equal(path.dirname(second.argv[1]), path.join(directory, 'executions'));
    assert.deepEqual(second.argv.slice(2), ['--addr', 'FAKE-USB', '--batch', '-v']);
    assert.deepEqual(second.document, active, 'raw presets run unchanged');
    assert.deepEqual(await fs.readdir(path.join(directory, 'executions')), [], 'temporary documents are removed');
  } finally {
    Object.assign(cfg, previous);
    for (const [key, value] of [['NODE_OPTIONS', oldOptions], ['FAKE_CAPTURE', oldCapture], ['FAKE_TASKS_DIR', oldTasks], ['FAKE_EXIT', oldExit]] as const) {
      if (value === undefined) delete (process.env as any)[key]; else (process.env as any)[key] = value;
    }
    await fs.rm(directory, {recursive: true, force: true});
  }
});
