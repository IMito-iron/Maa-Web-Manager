import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../src/engine';
import {cfg} from '../src/config';
import {attachGuis, compileTask, defaultGui, neutralContext, parseRunOverrides} from '../src/maa-model';

const settings = {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false};
const preset = attachGuis({client_type: 'Official', tasks: [{type: 'Fight', params: {}}, {type: 'Recruit', params: {}}, {type: 'Award', params: {}}, {type: 'Fight', params: {stage: '1-7'}}]},
  [{...defaultGui('Fight'), MedicineCount: 5, StoneCount: 2, TimesLimit: 3}, defaultGui('Recruit'), defaultGui('Award'), undefined], settings);

test('parseRunOverrides accepts only run-only fields of Windows-mode Fight/Recruit tasks', () => {
  assert.deepEqual(parseRunOverrides({0: {UseStone: true, UseMedicine: false}, 1: {UseExpedited: true}}, preset), {0: {UseStone: true}, 1: {UseExpedited: true}});
  assert.equal(parseRunOverrides({0: {UseStone: false}}, preset), null, 'all-false is no override');
  assert.equal(parseRunOverrides(undefined, preset), null);
  for (const bad of [{2: {UseStone: true}}, {3: {UseStone: true}}, {9: {UseStone: true}}, {0: {Series: true}}, {0: {UseStone: 'yes'}}, {'01': {UseStone: true}}, [1]]) {
    assert.throws(() => parseRunOverrides(bad, preset), /overrides/, JSON.stringify(bad));
  }
});

test('run-only stone follows the Windows setter: medicine 999 and medicine enabled for this run', () => {
  const gui = {...defaultGui('Fight'), MedicineCount: 5, StoneCount: 2, TimesLimit: 3};
  const run = (o?: any) => (compileTask({type: 'Fight', gui, index: 0, client: 'Official', settings, ctx: {...neutralContext('Official'), overrides: () => o}, enabledFights: [], stateKey: ''}) as any);
  assert.deepEqual([run().params.medicine, run().params.stone, run().params.times], [0, 0, 2147483647]);
  const stone = run({UseStone: true});
  assert.deepEqual([stone.params.medicine, stone.params.stone], [999, 2]);
  assert.match(stone.notes.join(), /本次运行临时启用/);
  assert.equal(run({EnableTimesLimit: true}).params.times, 3);
  assert.equal(run({UseMedicine: true}).params.medicine, 5);
});

test('engine: manual runs store validated overrides; scheduled runs cannot carry them; dispatch applies them', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-overrides-'));
  const previous = {...cfg}, oldOptions = process.env.NODE_OPTIONS, oldCapture = process.env.FAKE_CAPTURE;
  const preload = path.join(directory, 'fake-maa.cjs'), capture = path.join(directory, 'capture.jsonl');
  Object.assign(cfg, {data: directory, maa: process.execPath, stageActivity: path.join(directory, 'none.json'), mallHistory: path.join(directory, 'state', 'm.json')});
  await Promise.all(['logs', 'executions'].map(name => fs.mkdir(path.join(directory, name))));
  await fs.writeFile(preload, `const fs=require('node:fs');const a=process.argv.slice(1);const d=String(a[1]||'').includes('executions')?JSON.parse(fs.readFileSync(a[1],'utf8')):null;fs.appendFileSync(process.env.FAKE_CAPTURE,JSON.stringify(d)+String.fromCharCode(10));process.exit(0);`);
  process.env.NODE_OPTIONS = '--require=' + JSON.stringify(preload);
  process.env.FAKE_CAPTURE = capture;
  const raw = JSON.stringify(preset);
  const created: any[] = [];
  const tx = {run: {findFirst: async () => null, create: async (v: any) => { created.push(v.data); return v.data; }}};
  const updates: any[] = [];
  const store: any = {serial: async (f: any) => f(), read: async () => ({name: 'p', raw, version: 'v'}), db: {...tx, run: {...tx.run, update: async (v: any) => updates.push(v.data)}}};
  const engine: any = new Engine(store, {binding: async () => ({address: 'FAKE-USB'}), prepare: async () => {}} as any, {get: async () => ({stage: null, learnedAt: null}), learn: async () => {}});
  engine.signal = () => {};
  try {
    await engine.enqueue('p', 'manual', undefined, undefined, tx, {0: {UseStone: true}});
    assert.equal(created[0].overrides, JSON.stringify({0: {UseStone: true}}));
    await engine.enqueue('p', 'manual', undefined, undefined, tx);
    assert.equal(created[1].overrides, null);
    await assert.rejects(engine.enqueue('p', 'schedule', 's', 'o', tx, {0: {UseStone: true}}), /manual runs/);
    await assert.rejects(engine.enqueue('p', 'manual', undefined, undefined, tx, {2: {UseStone: true}}), /no run-only options/);
    await engine.start({id: '00000000-0000-4000-8000-000000000201', task: 'p', hash: 'v', snapshot: raw, source: 'manual', overrides: created[0].overrides});
    for (let i = 0; i < 300 && engine.current; i++) await new Promise(r => setTimeout(r, 10));
    const doc = JSON.parse((await fs.readFile(capture, 'utf8')).trim().split('\n')[0]);
    assert.deepEqual([doc.tasks[0].params.medicine, doc.tasks[0].params.stone], [999, 2]);
    assert.match(await fs.readFile(path.join(directory, 'logs', '00000000-0000-4000-8000-000000000201.log'), 'utf8'), /本次运行临时启用：UseStone/);
  } finally {
    Object.assign(cfg, previous);
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
    if (oldCapture === undefined) delete process.env.FAKE_CAPTURE; else process.env.FAKE_CAPTURE = oldCapture;
    await fs.rm(directory, {recursive: true, force: true});
  }
});
