import test from 'node:test';
import assert from 'node:assert/strict';
import {attachGuis, compilePreset, defaultGui, migratePreset, neutralContext, paramsHash, readGuis, readSettings, staleGuis, StageCatalog, INT_MAX} from '../src/maa-model';

// Shape of the production daily preset (docs/daily-preset.md): annihilation, return home, drain.
const daily = {
  name: '日常', client_type: 'Official', startup: true, closedown: false,
  tasks: [
    {name: '开始唤醒', type: 'StartUp', params: {client_type: 'Official', start_game_enabled: true}},
    {name: '剿灭', type: 'Fight', params: {stage: 'Annihilation', series: 1, medicine: 0, expiring_medicine: 0, medicine_expire_days: 0, stone: 0, times: INT_MAX}},
    {name: '返回主页', type: 'Custom', params: {task_names: ['ManagerReturnHome']}},
    {name: '剩余理智', type: 'Fight', params: {stage: '', series: 0, medicine: 0, expiring_medicine: 0, medicine_expire_days: 0, stone: 0, times: INT_MAX}},
    {name: '领取奖励', type: 'Award', params: {award: true, mail: true}},
    {name: '信用', type: 'Mall', params: {visit_friends: true, shopping: true, buy_first: ['招聘许可'], blacklist: ['加急许可']}},
    {name: '基建', type: 'Infrast', params: {mode: 0, facility: ['Mfg', 'Trade', 'Power', 'Control'], drones: 'Money'}},
    {name: '抄作业', type: 'Copilot', params: {filename: 'a.json'}},
  ],
};

test('daily preset: Fight/Custom/StartUp/Award convert losslessly; Core defaults fill missing keys', () => {
  const m = migratePreset(daily);
  assert.equal(m.tasks[0]!.lossless, true, JSON.stringify(m.tasks[0]!.differences));
  assert.equal(m.tasks[1]!.lossless, true, JSON.stringify(m.tasks[1]!.differences));
  assert.deepEqual(m.tasks[1]!.gui.StagePlan, ['Annihilation']);
  assert.equal(m.tasks[1]!.gui.Series, 1, 'missing/explicit series keeps Core meaning, not the Windows default 0');
  assert.equal(m.tasks[2]!.lossless, true);
  assert.equal(m.tasks[3]!.lossless, true);
  assert.equal(m.tasks[4]!.lossless, true);
  assert.equal(m.tasks[7], null, 'task types without a Windows model stay raw');
});

test('migration reports real behaviour changes instead of converting silently', () => {
  const m = migratePreset(daily);
  const mall = m.tasks[5]!;
  assert.equal(mall.lossless, false);
  assert.deepEqual(mall.differences.map(d => d.key), ['blacklist'], 'Windows always appends the client fixed blacklist');
  const infrast = m.tasks[6]!;
  assert.equal(infrast.lossless, false);
  assert.ok(infrast.differences.some(d => d.key === 'facility'), 'Normal mode re-sorts facilities into enum order');
  const recruit = migratePreset({tasks: [{type: 'Recruit', params: {select: [3, 4], confirm: [3, 4], expedite: true}}]}).tasks[0]!;
  assert.deepEqual(recruit.differences.map(d => d.key).sort(), ['expedite', 'select'].sort());
});

test('deprecated keys are resolved like Core resolves them', () => {
  const skipRobot = migratePreset({tasks: [{type: 'Recruit', params: {select: [4], confirm: [3, 4], skip_robot: true, refresh: true, force_refresh: true, times: 4}}]}).tasks[0]!;
  assert.equal(skipRobot.lossless, true, JSON.stringify(skipRobot.differences));
  assert.deepEqual([skipRobot.gui.PreserveTagEnabled, skipRobot.gui.PreserveTagList], [true, ['支援机械']]);
  const expiring = migratePreset({tasks: [{type: 'Fight', params: {stage: '1-7', expiring_medicine: 5}}]}).tasks[0]!;
  assert.equal(expiring.lossless, true);
  assert.deepEqual([expiring.gui.UseExpiringMedicine, expiring.gui.MedicineExpireDays], [true, 2]);
  const rogue = migratePreset({tasks: [{type: 'Roguelike', params: {theme: 'Phantom', mode: 0, squad: '指挥分队', roles: '稳扎稳打', core_char: '羽毛笔', use_support: true, starts_count: 99999, difficulty: INT_MAX}}]}).tasks[0]!;
  assert.equal(rogue.lossless, true, JSON.stringify(rogue.differences));
  assert.deepEqual(rogue.gui.StartingOpers, [{Name: '羽毛笔', UseSupport: true}]);
});

test('preset envelope round trip: manager entries align by index and fall back to raw on hand edits', () => {
  const guis = [undefined, {...defaultGui('Fight'), StagePlan: ['LS-6']}, undefined];
  const doc = {client_type: 'Official', tasks: [daily.tasks[0], daily.tasks[1], daily.tasks[7]]};
  const saved = attachGuis(doc, guis, {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false});
  assert.equal(saved.manager.tasks[0], null);
  assert.equal(saved.tasks[1].params.stage, 'LS-6', 'neutral params are written so maa-cli / an older Manager can still run it');
  assert.equal(saved.manager.tasks[1].paramsHash, paramsHash(saved.tasks[1].params));
  assert.deepEqual(readGuis(saved).map(Boolean), [false, true, false]);
  assert.equal(readSettings(saved).StartGame, true);
  const edited = JSON.parse(JSON.stringify(saved));
  edited.tasks[1].params.stage = 'CE-6';
  assert.deepEqual(readGuis(edited).map(Boolean), [false, false, false]);
  assert.deepEqual(staleGuis(edited), [false, true, false]);
  for (const t of saved.tasks) assert.deepEqual(Object.keys(t).filter(k => !['name', 'type', 'params', 'strategy', 'variants'].includes(k)), [], 'no unknown task keys (maa-cli deny_unknown_fields)');
});

test('compilePreset: manager removed, skipped tasks dropped, errors collected, raw tasks untouched', () => {
  const guis = [{...defaultGui('Fight'), UseWeeklySchedule: true, WeeklySchedule: {Friday: false}}, defaultGui('Award'), {...defaultGui('Infrast'), Mode: 'Custom', PlanSelect: 3, Filename: '/x.json'}];
  const doc = attachGuis({client_type: 'Official', tasks: [{type: 'Fight', params: {}}, {type: 'Award', params: {}}, {type: 'Infrast', params: {}}, {type: 'Copilot', params: {filename: 'a.json'}}]}, guis,
    {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false});
  const ctx = {now: new Date('2026-08-07T06:13:08Z'), neutral: false, stages: new StageCatalog('Official'), localTimeZone: 'Asia/Shanghai', infrastPlans: () => ({ok: false as const, missing: true})};
  const out = compilePreset(doc, ctx, 'p');
  assert.equal('manager' in out.document, false);
  assert.deepEqual(out.document.tasks.map((t: any) => t.type), ['Award', 'Copilot']);
  assert.equal(out.reports[0].result!.kind, 'skip');
  assert.equal(out.errors.length, 1);
  assert.deepEqual(out.document.tasks[1], {type: 'Copilot', params: {filename: 'a.json'}});
  const neutral = compilePreset(doc, neutralContext('Official'));
  assert.equal(neutral.errors.length, 0);
});

test('disabled GUI tasks keep the never-active variant and are not compiled', () => {
  const doc = attachGuis({tasks: [{type: 'Award', params: {}, variants: [{condition: {type: 'Not', condition: {type: 'Always'}}}]}]}, [defaultGui('Award')],
    {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false});
  const out = compilePreset(doc, neutralContext('Official'));
  assert.equal(out.document.tasks[0].variants.length, 1);
  assert.equal(out.reports[0].result!.kind, 'skip');
});
