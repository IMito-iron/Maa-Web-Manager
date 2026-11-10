import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../src/engine';
import {cfg} from '../src/config';
import {attachGuis, defaultGui, WEEK_DAYS} from '../src/maa-model';

const settings = {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false};

test('Engine compiles GUI tasks at dispatch, runs the compiled snapshot and skips all-skipped runs without spawning', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-win-parity-'));
  const previous = {...cfg}, oldOptions = process.env.NODE_OPTIONS, oldCapture = process.env.FAKE_CAPTURE;
  const preload = path.join(directory, 'fake-maa.cjs'), capture = path.join(directory, 'capture.jsonl');
  Object.assign(cfg, {data: directory, tasks: path.join(directory, 'tasks'), maa: process.execPath,
    stageActivity: path.join(directory, 'cache', 'none.json'), mallHistory: path.join(directory, 'state', 'mall.json')});
  await Promise.all(['logs', 'executions', 'tasks'].map(name => fs.mkdir(path.join(directory, name))));
  await fs.writeFile(preload, `const fs=require('node:fs');const a=process.argv.slice(1);`
    + `const document=String(a[1]||'').includes('executions')?JSON.parse(fs.readFileSync(a[1],'utf8')):null;`
    + `fs.appendFileSync(process.env.FAKE_CAPTURE,JSON.stringify({argv:a,document})+'\\n');process.exit(0);`);
  process.env.NODE_OPTIONS = '--require=' + JSON.stringify(preload);
  process.env.FAKE_CAPTURE = capture;
  const updates: any[] = [];
  const store: any = {serial: async (f: any) => f(), db: {run: {update: async (v: any) => updates.push(v.data), findFirst: async () => null, create: async () => {}}}};
  let prepared = 0;
  const engine: any = new Engine(store, {binding: async () => ({address: 'FAKE-USB'}), prepare: async () => {prepared++;}} as any,
    {get: async () => ({stage: null, learnedAt: null}), learn: async () => {}});
  engine.signal = () => {};
  const awaitFinish = async () => {for (let i = 0; i < 300; i++) {if (!engine.current) return; await new Promise(r => setTimeout(r, 10));} throw Error('Fake child did not finalize');};
  try {
    const doc = attachGuis({name: 'p', client_type: 'Official', tasks: [{name: '奖励', type: 'Award', params: {}}, {name: '理智', type: 'Fight', params: {}}]},
      [{...defaultGui('Award'), Mail: true}, {...defaultGui('Fight'), StagePlan: ['1-7']}], settings);
    await engine.start({id: '00000000-0000-4000-8000-000000000101', task: 'p', hash: 'h', snapshot: JSON.stringify(doc), source: 'manual'});
    await awaitFinish();
    const first = JSON.parse((await fs.readFile(capture, 'utf8')).trim().split('\n')[0]);
    assert.equal('manager' in first.document, false, 'maa-cli never sees the Manager section');
    assert.equal(first.document.tasks[0].params.mail, true);
    assert.equal(first.document.tasks[1].params.stage, '1-7');
    assert.equal(first.document.tasks[1].params.series, 0, 'Windows default AUTO');
    const log = await fs.readFile(path.join(directory, 'logs', '00000000-0000-4000-8000-000000000101.log'), 'utf8');
    assert.match(log, /^\[Manager\] #1 奖励 \(Award\): \{"award":true,"mail":true/);
    assert.equal(updates.at(-1).status, 'success');

    const off = Object.fromEntries(WEEK_DAYS.map(d => [d, false]));
    const skipped = attachGuis({client_type: 'Official', tasks: [{type: 'Fight', params: {}}]}, [{...defaultGui('Fight'), UseWeeklySchedule: true, WeeklySchedule: off}], settings);
    const before = prepared;
    await engine.start({id: '00000000-0000-4000-8000-000000000102', task: 'p', hash: 'h', snapshot: JSON.stringify(skipped), source: 'schedule'});
    assert.equal(updates.at(-1).status, 'skipped');
    assert.equal(prepared, before, 'device is not woken when nothing would run');
    assert.match(await fs.readFile(path.join(directory, 'logs', '00000000-0000-4000-8000-000000000102.log'), 'utf8'), /跳过 理智作战周计划/);

    const broken = attachGuis({client_type: 'Official', tasks: [{type: 'Infrast', params: {}}]}, [{...defaultGui('Infrast'), Mode: 'Custom', Filename: 'missing.json', PlanSelect: 2}], settings);
    await assert.rejects(engine.start({id: '00000000-0000-4000-8000-000000000103', task: 'p', hash: 'h', snapshot: JSON.stringify(broken), source: 'manual'}), /计划序号超出范围/);
    assert.deepEqual(await fs.readdir(path.join(directory, 'executions')), []);
  } finally {
    Object.assign(cfg, previous);
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
    if (oldCapture === undefined) delete process.env.FAKE_CAPTURE; else process.env.FAKE_CAPTURE = oldCapture;
    await fs.rm(directory, {recursive: true, force: true});
  }
});
