import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CallbackLogFilter, recordMallHistory} from '../src/mall-history';
import {Engine} from '../src/engine';
import {cfg} from '../src/config';
import {runtimeContext} from '../src/maa-runtime';
import {attachGuis, compilePreset, defaultGui, gameDate, mallOnceADayPlan, neutralContext} from '../src/maa-model';

const ts = '[2026-11-09 14:00:00 ';
const trace = (taskchain: string, task: string, taskid = 3) =>
  `${ts}TRACE] UnknownSubTaskStart: ${JSON.stringify({class: 'asst::ProcessTask', details: {task, action: 'ClickSelf', exec_times: 1}, subtask: 'ProcessTask', taskchain, taskid}, null, 2)}\n`;
const vLog = `${ts}INFO ] Connected\n${ts}INFO ] Mall Start\n${ts}INFO ] Mall Completed\n${ts}INFO ] 信用 Start\n${ts}INFO ] Mall Start\n${ts}WARN ] something 中文\nsummary line\n`;
const vvvLog = `${ts}DEBUG] Adding task [Mall] with params: {\n  "shopping": true\n}\n${ts}INFO ] Connected\n${trace('Infrast', 'VisitLimited', 1)}`
  + `${ts}INFO ] Mall Start\n${trace('Mall', 'VisitLimited')}${ts}INFO ] Mall Completed\n${ts}INFO ] 信用 Start\n${ts}INFO ] Mall Start\n`
  + `${trace('Mall', 'StageDrops-Stars-3', 4)}${trace('Mall', 'Shopping', 4)}${ts}WARN ] something 中文\nsummary line\n`;
const settings = {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false};

test('CallbackLogFilter: a -vvv stream becomes the -v log; Mall markers are attributed per Mall chain', () => {
  const filter = new CallbackLogFilter();
  const bytes = Buffer.from(vvvLog);
  let out = '';
  for (let i = 0; i < bytes.length; i += 7) out += filter.feed(bytes.subarray(i, i + 7)); // splits lines and UTF-8 chars
  out += filter.flush();
  assert.equal(out, vLog);
  assert.deepEqual(filter.markers, [{ordinal: 0, kind: 'visitFriends'}, {ordinal: 1, kind: 'creditFight'}]);
});

test('CallbackLogFilter keeps unprefixed Manager notes that follow a DEBUG/TRACE record', () => {
  // The account sequence prints its identity notes ("\n[ACCOUNT_…]\n") without a log prefix; the
  // Manager reads them back from the run log, so they must never be swallowed with a TRACE block.
  const note = '\n[ACCOUNT_IDENTITY_UNVERIFIED_COMPAT] 兼容模式\n';
  const brace = `${ts}TRACE] UnknownSubTaskStart: ${JSON.stringify({taskchain: 'Mall', subtask: 'ProcessTask', details: {task: 'VisitLimited', text: 'a } b ['}}, null, 2)}\n`;
  const filter = new CallbackLogFilter();
  const out = filter.feed(Buffer.from(`${ts}INFO ] Mall Start\n${brace}${note}${ts}DEBUG] single line\nplain after debug\n`)) + filter.flush();
  assert.equal(out, `${ts}INFO ] Mall Start\n${note}plain after debug\n`);
  assert.deepEqual(filter.markers, [{ordinal: 0, kind: 'visitFriends'}], 'brackets inside strings do not end the JSON early');
});

test('mallOnceADayPlan maps Mall chains to task keys; a raw conditional Mall disables recording', () => {
  const doc = attachGuis({client_type: 'Official', tasks: [{type: 'Mall', params: {}}, {type: 'Award', params: {}}, {type: 'Mall', params: {}}]},
    [{...defaultGui('Mall'), VisitFriendsOnceADay: false, CreditFightOnceADay: false}, defaultGui('Award'), {...defaultGui('Mall'), VisitFriendsOnceADay: true}], settings);
  assert.deepEqual(mallOnceADayPlan(doc, compilePreset(doc, neutralContext('Official'), 'p'), 'p'), {keys: [null, 'p#2#Mall']});
  const none = attachGuis({tasks: [{type: 'Mall', params: {}}]}, [{...defaultGui('Mall'), CreditFightOnceADay: false}], settings);
  assert.equal(mallOnceADayPlan(none, compilePreset(none, neutralContext('Official'), 'p'), 'p'), null, 'no once-a-day option → no tracing');
  const conditional = {...doc, tasks: [...doc.tasks, {type: 'Mall', params: {}, variants: [{condition: {type: 'Always'}}]}]};
  assert.equal(mallOnceADayPlan(conditional, compilePreset(conditional, neutralContext('Official'), 'p'), 'p'), null);
});

test('engine: once-a-day Mall runs use -vvv, store a -v log, record the game date and gate the next run', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-mall-'));
  const previous = {...cfg};
  const saved = {NODE_OPTIONS: process.env.NODE_OPTIONS, FAKE_CAPTURE: process.env.FAKE_CAPTURE, FAKE_STDERR: process.env.FAKE_STDERR};
  const preload = path.join(directory, 'fake-maa.cjs'), capture = path.join(directory, 'capture.jsonl');
  Object.assign(cfg, {data: directory, maa: process.execPath, stageActivity: path.join(directory, 'none.json'), mallHistory: path.join(directory, 'state', 'mall-history.json')});
  await Promise.all(['logs', 'executions'].map(name => fs.mkdir(path.join(directory, name))));
  await fs.writeFile(path.join(directory, 'stderr.txt'), vvvLog);
  await fs.writeFile(preload, "const fs=require('node:fs');"
    + "fs.appendFileSync(process.env.FAKE_CAPTURE,JSON.stringify(process.argv.slice(1))+String.fromCharCode(10));"
    + "fs.writeSync(2,fs.readFileSync(process.env.FAKE_STDERR));process.exit(0);");
  Object.assign(process.env, {NODE_OPTIONS: '--require=' + JSON.stringify(preload), FAKE_CAPTURE: capture, FAKE_STDERR: path.join(directory, 'stderr.txt')});
  const updates: any[] = [];
  const store: any = {serial: async (f: any) => f(), db: {run: {update: async (v: any) => updates.push(v.data), findFirst: async () => null, create: async () => {}}}};
  const engine: any = new Engine(store, {binding: async () => ({address: 'FAKE-USB'}), prepare: async () => {}} as any, {get: async () => ({stage: null, learnedAt: null}), learn: async () => {}});
  engine.signal = () => {};
  const finish = async () => { for (let i = 0; i < 300 && engine.current; i++) await new Promise(r => setTimeout(r, 10)); };
  try {
    const doc = attachGuis({client_type: 'Official', tasks: [{type: 'Mall', params: {}}, {name: '信用', type: 'Mall', params: {}}]},
      [{...defaultGui('Mall'), VisitFriendsOnceADay: true}, {...defaultGui('Mall'), CreditFight: true, CreditFightOnceADay: true}], settings);
    await engine.start({id: '00000000-0000-4000-8000-000000000301', task: 'daily', hash: 'v', snapshot: JSON.stringify(doc), source: 'manual'});
    await finish();
    const argv = JSON.parse((await fs.readFile(capture, 'utf8')).trim().split('\n')[0]);
    assert.equal(argv.at(-1), '-vvv');
    const log = await fs.readFile(path.join(directory, 'logs', '00000000-0000-4000-8000-000000000301.log'), 'utf8');
    assert.ok(log.endsWith(vLog), 'stored log equals the -v output after the compile report');
    assert.doesNotMatch(log, /TRACE|DEBUG|UnknownSubTaskStart/);
    const today = gameDate(new Date(), 'Official');
    assert.deepEqual(JSON.parse(await fs.readFile(cfg.mallHistory, 'utf8')), {'daily#0#Mall': {visitFriends: today}, 'daily#1#Mall': {creditFight: today}});
    // The next compile on the same game day skips both once-a-day actions.
    const next = compilePreset(doc, runtimeContext(JSON.stringify(doc)), 'daily');
    assert.equal(next.document.tasks[0].params.visit_friends, false);
    assert.equal(next.document.tasks[1].params.credit_fight, false);

    const plain = attachGuis({client_type: 'Official', tasks: [{type: 'Award', params: {}}]}, [defaultGui('Award')], settings);
    await engine.start({id: '00000000-0000-4000-8000-000000000302', task: 'other', hash: 'v', snapshot: JSON.stringify(plain), source: 'manual'});
    await finish();
    assert.equal(JSON.parse((await fs.readFile(capture, 'utf8')).trim().split('\n')[1]).at(-1), '-v', 'other runs keep -v');
    const plainLog = await fs.readFile(path.join(directory, 'logs', '00000000-0000-4000-8000-000000000302.log'), 'utf8');
    assert.match(plainLog, /UnknownSubTaskStart/, 'without the plan stderr is stored unfiltered, as before');
  } finally {
    Object.assign(cfg, previous);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v;
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('recordMallHistory merges per key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-mh-'));
  const file = path.join(dir, 'state', 'm.json');
  await recordMallHistory(file, {'p#0#Mall': {visitFriends: '2026-11-08'}});
  await recordMallHistory(file, {'p#0#Mall': {creditFight: '2026-11-09'}});
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {'p#0#Mall': {visitFriends: '2026-11-08', creditFight: '2026-11-09'}});
  await fs.rm(dir, {recursive: true, force: true});
});
