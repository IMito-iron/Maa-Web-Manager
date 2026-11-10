// Golden tests: Web-Manager compiled task params vs Windows MAA.
// Fixture = the real (redacted) Windows config queue + Core-logged params of the same machine
// (Core v6.16.5). Expected values are the sample adjusted by the documented v6.16.5 → v6.21.4
// differences (mapping.md §样本对照), each noted inline. Tasks without a sample are tested against
// the v6.21.4 source-derived rule and marked "source-derived".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {compileTask, StageCatalog, defaultGui, type CompileInput, type Gui, type GuiTaskType, type RuntimeContext, INT_MAX} from '../src/maa-model';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'windows-v6.21.4.json'), 'utf8'));
const queue: Gui[] = fixture.taskQueue;
const sample = fixture.samplesV6165;
const settings = fixture.settings;
const SAMPLE_TIME = new Date('2026-08-07T06:13:08Z'); // 14:13 CST, Friday (game day Friday)

const ctx = (over: Partial<RuntimeContext> = {}): RuntimeContext => ({
  now: SAMPLE_TIME, neutral: false, stages: new StageCatalog('Official', null), localTimeZone: 'Asia/Shanghai', ...over,
});
const run = (type: GuiTaskType, gui: Gui, over: Partial<CompileInput> = {}) => compileTask({
  type, gui, index: 0, client: 'Official', settings, ctx: ctx(), enabledFights: [], stateKey: 'k', ...over,
});
const params = (type: GuiTaskType, gui: Gui, over: Partial<CompileInput> = {}) => {
  const r = run(type, gui, over);
  assert.equal(r.kind, 'append', JSON.stringify(r));
  return (r as any).params;
};
const byType = (t: string) => queue.filter(q => q.$type === t);
const without = (o: any, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

test('StartUp matches the Windows sample exactly', () => {
  assert.deepEqual(params('StartUp', byType('StartUpTask')[0]), sample.StartUp);
});

test('Recruit: sample + level3_recruitment_permit_reserve, yituliu_id becomes "" (YituliuId never assigned in v6.21.4)', () => {
  const expected = {...sample.Recruit, level3_recruitment_permit_reserve: 0, yituliu_id: ''};
  assert.deepEqual(params('Recruit', byType('RecruitTask')[0]), expected);
});

test('Infrast (queue switched back to Normal as on the sample day): enum-ordered facility, ÷100, +6 v6.21 keys', () => {
  const gui = {...byType('InfrastTask')[0], Mode: 'Normal'};
  const expected = {...sample.Infrast, fiammetta_targets: ['清流', '可露希尔', '但书'], fiammetta_recovery_enabled: false,
    use_pinus_sylvestris: false, use_perception_information: false, use_worldly_plight: false, use_abyssal_hunter: false};
  const out = params('Infrast', gui);
  assert.deepEqual(out, expected);
  assert.deepEqual(out.facility, ['Mfg', 'Trade', 'Control', 'Power', 'Reception', 'Office', 'Dorm', 'Processing', 'Training'], 'UI order Power,Office,… is re-sorted');
});

test('Fight with fallback plan ["", "LS-6", ""] picks "" and matches the sample minus yituliu_id', () => {
  assert.deepEqual(params('Fight', byType('FightTask')[1]), without(sample.Fight, 'yituliu_id'));
});

test('Mall matches the sample (visit once-a-day, last visit the previous game day) incl. fixed blacklist', () => {
  const mall = byType('MallTask')[0];
  const out = params('Mall', mall, {ctx: ctx({mallHistory: () => ({visitFriends: '2026-08-06', creditFight: '2023-10-22'})})});
  assert.deepEqual(out, sample.Mall);
  const visited = params('Mall', mall, {ctx: ctx({mallHistory: () => ({visitFriends: '2026-08-07'})})});
  assert.equal(visited.visit_friends, false, 'already visited this game day');
});

test('Award: sample + signinevent', () => {
  assert.deepEqual(params('Award', byType('AwardTask')[0]), {...sample.Award, signinevent: false});
});

test('Roguelike: core_char/use_support → core_char_list; investment_with_more_score only in Investment mode', () => {
  const out = params('Roguelike', byType('RoguelikeTask')[0]);
  assert.deepEqual(out, {
    mode: 0, theme: 'JieGarden', difficulty: INT_MAX, starts_count: 99999, investment_enabled: true,
    investment_with_more_score: false, investments_count: INT_MAX, stop_when_investment_full: false,
    squad: '指挥分队', roles: '稳扎稳打', core_char_list: [{name: '维什戴尔', use_support: true}],
    stop_at_final_boss: false, stop_at_max_level: false, use_nonfriend_support: true, refresh_trader_with_dice: false,
  });
  // Same key set as the v6.16.5 sample apart from the documented core_char change.
  assert.deepEqual(Object.keys(out).sort(), Object.keys(without({...sample.Roguelike, core_char_list: 1}, 'core_char', 'use_support')).sort());
});

test('defaults of every GUI task compile (schema defaults, source-derived)', () => {
  assert.deepEqual(params('Award', defaultGui('Award')), {award: true, mail: false, recruit: false, orundum: false, mining: false, specialaccess: false, signinevent: false});
  assert.deepEqual(params('Recruit', defaultGui('Recruit')).select, [4]);
  assert.deepEqual(params('Recruit', defaultGui('Recruit')).confirm, [3, 4]);
  assert.equal(params('Fight', defaultGui('Fight')).series, 0);
  assert.equal(params('Infrast', defaultGui('Infrast')).facility.length, 11);
  assert.deepEqual(params('Mall', defaultGui('Mall')).buy_first, ['招聘许可']);
  assert.deepEqual(params('StartUp', defaultGui('StartUp')), {start_game_enabled: true, client_type: 'Official'});
  assert.equal(run('SwitchTheme', defaultGui('SwitchTheme')).kind, 'skip');
  assert.deepEqual(params('Custom', {CustomTaskName: 'A, B,,C'}), {task_names: ['A', 'B', 'C']});
});

test('weekly schedule skips Fight and Infrast on unchecked game days (game day starts 04:00 CST)', () => {
  const fight = {...defaultGui('Fight'), UseWeeklySchedule: true, WeeklySchedule: {Friday: false}};
  assert.equal(run('Fight', fight).kind, 'skip');
  // 03:59 CST Friday is still game-day Thursday.
  assert.equal(run('Fight', fight, {ctx: ctx({now: new Date('2026-08-06T19:59:00Z')})}).kind, 'append');
  assert.equal(run('Infrast', {...defaultGui('Infrast'), UseWeeklySchedule: true, WeeklySchedule: {Friday: false}}).kind, 'skip');
});

test('Fight backup stages: first stage open today; none open → skip', () => {
  // Friday: CE-6 (Tue/Thu/Sat/Sun) closed, SK-5 (Mon/Wed/Fri/Sat) open.
  const gui = {...defaultGui('Fight'), UseOptionalStage: true, StagePlan: ['CE-6', 'SK-5', 'LS-6']};
  assert.equal(params('Fight', gui).stage, 'SK-5');
  assert.equal(run('Fight', {...gui, StagePlan: ['CE-6', 'AP-5']}).kind, 'skip');
  assert.equal(params('Fight', {...gui, StagePlan: ['XX-9', 'LS-6']}).stage, 'LS-6', 'unknown XX-n codes are expired activities');
  assert.equal(run('Fight', {...defaultGui('Fight'), StagePlan: ['CE-6', 'SK-5']}).kind, 'skip', 'without UseOptionalStage only the first entry (closed CE-6) exists');
});

test('Fight tri-state: stone not saved unless UseStoneAllowSave; run-only overrides apply; times gate; custom annihilation', () => {
  const g = {...defaultGui('Fight'), UseStone: true, StoneCount: 3, UseMedicine: false, MedicineCount: 7, TimesLimit: 5};
  assert.equal(params('Fight', g).stone, 0, 'UseStone is forced false on load when saving is not allowed');
  assert.equal(params('Fight', {...g, UseStoneAllowSave: true}).stone, 3);
  const once = params('Fight', g, {ctx: ctx({overrides: () => ({UseStone: true, UseMedicine: true, EnableTimesLimit: true})})});
  // Run-only stone applies the Windows UseStone setter: MedicineCount=999 for this run.
  assert.deepEqual([once.stone, once.medicine, once.times], [3, 999, 5]);
  assert.equal(params('Fight', g).times, INT_MAX);
  assert.equal(params('Fight', {...g, StagePlan: ['Annihilation'], UseCustomAnnihilation: true, AnnihilationStage: 'Chernobog@Annihilation'}).stage, 'Chernobog@Annihilation');
  assert.equal(params('Fight', {...g, EnableTargetDrop: true, DropId: '30012', DropCount: 4}).drops['30012'], 4);
  assert.equal(run('Fight', {...g, EnableTargetDrop: true, IsInventoryTarget: true, DropId: '30012', DropCount: 4}).kind, 'skip');
});

test('Fight penguin_id only with reporting and a non-empty id; yituliu_id never', () => {
  const off = params('Fight', defaultGui('Fight'), {settings: {...settings, ReportToPenguin: false}});
  assert.equal('penguin_id' in off, false);
  assert.equal('yituliu_id' in params('Fight', defaultGui('Fight')), false);
  assert.equal('penguin_id' in params('Fight', defaultGui('Fight'), {settings: {...settings, PenguinId: ' '}}), false);
});

test('Recruit: expedite never persisted; level 3 only confirms; permit reserve gated', () => {
  const g = {...defaultGui('Recruit'), UseExpedited: true, Level6Choose: true, Level3RecruitmentPermitReserveEnabled: true};
  const out = params('Recruit', g);
  assert.equal(out.expedite, false);
  assert.equal('expedite_times' in out, false);
  assert.deepEqual([out.select, out.confirm], [[4, 6], [3, 4, 6]]);
  assert.equal(out.level3_recruitment_permit_reserve, 8);
  const once = params('Recruit', g, {ctx: ctx({overrides: () => ({UseExpedited: true})})});
  assert.deepEqual([once.expedite, once.expedite_times], [true, 4]);
});

test('Infrast custom: plan_index only in Custom; -1 picks the plan whose period covers local time; out of range aborts', () => {
  const plans = {ok: true as const, plans: [{index: 0, period: [['04:00', '13:59']] as [string, string][]}, {index: 1, period: [['14:00', '23:59']] as [string, string][]}]};
  const g = {...defaultGui('Infrast'), Mode: 'Custom', Filename: '/cfg/infrast/a.json'};
  const auto = params('Infrast', g, {ctx: ctx({infrastPlans: () => plans})});
  assert.deepEqual([auto.mode, auto.filename, auto.plan_index], [10000, '/cfg/infrast/a.json', 1]);
  assert.equal(run('Infrast', {...g, PlanSelect: 5}, {ctx: ctx({infrastPlans: () => ({ok: false, missing: true})})}).kind, 'error');
  assert.equal(params('Infrast', {...g, PlanSelect: 5}, {ctx: ctx({infrastPlans: () => plans})}).plan_index, 0, 'loaded file resets an out-of-range selection');
  assert.equal('plan_index' in params('Infrast', defaultGui('Infrast')), false);
  const builtin = params('Infrast', {...g, CustomFileType: '153_layout_3_times_a_day.json'}, {ctx: ctx({builtinInfrastPath: f => `/res/custom_infrast/${f}`, infrastPlans: () => plans})});
  assert.equal(builtin.filename, '/res/custom_infrast/153_layout_3_times_a_day.json');
});

test('Mall: credit fight forced off while an enabled Fight resolves to "" on any scheduled day', () => {
  const g = {...defaultGui('Mall'), CreditFight: true, CreditFightOnceADay: false};
  assert.equal(params('Mall', g).credit_fight, true);
  const out = run('Mall', g, {enabledFights: [{...defaultGui('Fight'), StagePlan: ['']}]});
  assert.equal((out as any).params.credit_fight, false);
  assert.equal(out.notes.length, 1);
  assert.equal(params('Mall', g, {enabledFights: [{...defaultGui('Fight'), StagePlan: ['1-7']}]}).credit_fight, true);
});

test('StartUp: account name only when switching is enabled and the client supports it', () => {
  const g = {AccountName: '1234', AccountSwitchEnabled: true};
  assert.equal(params('StartUp', g).account_name, '1234');
  assert.equal('account_name' in params('StartUp', {...g, AccountSwitchEnabled: false}), false);
  assert.equal('account_name' in params('StartUp', g, {client: 'YoStarEN'}), false);
  assert.equal(params('StartUp', {AccountName: '1234'}).account_name, '1234', 'missing flag migrates to !!AccountName');
  assert.equal(params('StartUp', g, {settings: {...settings, StartGame: false}}).start_game_enabled, false);
});

test('server and blacklist follow the client type (source-derived)', () => {
  assert.equal(params('Fight', defaultGui('Fight'), {client: 'txwy'}).server, 'ZH_TW');
  assert.deepEqual(params('Mall', defaultGui('Mall'), {client: 'YoStarJP'}).blacklist, ['碳', '家具', '加急许可', 'クーリエ', 'ガヴィル', 'ジュナー']);
});

test('Roguelike gating (source-derived): BlackFlow flight presets, Collectible start list, Utopia difficulty', () => {
  const base = defaultGui('Roguelike');
  const flight = params('Roguelike', {...base, Theme: 'BlackFlow', BlackFlowFastFlight: true, Squad: '矛头分队'});
  assert.deepEqual([flight.squad, flight.roles, flight.core_char_list, 'blackflow_strategy' in flight], ['特勤分队', '稳扎稳打', [{name: '机械师', use_support: false}], false]);
  assert.equal(params('Roguelike', {...base, Theme: 'BlackFlow'}).blackflow_strategy, 'ending1');
  const coll = params('Roguelike', {...base, Theme: 'Mizuki', Mode: 'Collectible', SquadCollectible: '指挥分队', CollectibleStartAwards: 'HotWater, Hope'});
  assert.deepEqual(coll.collectible_mode_start_list, {hot_water: true, shield: false, ingot: false, hope: true, random: false, key: false, dice: false, ideas: false, ticket: false});
  assert.equal('stop_at_final_boss' in coll, false);
  const run30003 = params('Roguelike', {...base, Theme: 'BlackFlow', Mode: 'BlackFlowStartRun', Difficulty: 3, BlackFlowStartUtopia: true, BlackFlowStartAnimal1: 'Cat', BlackFlowStartRewards: ['Pegasus', 'SpaceLease']});
  assert.deepEqual([run30003.blackflow_start_animals, run30003.blackflow_start_rewards, 'blackflow_start_utopia' in run30003], [['swaddled_cat'], 4, false]);
  const utopia = params('Roguelike', {...base, Theme: 'BlackFlow', Mode: 'BlackFlowStartRun', Difficulty: -1, BlackFlowStartUtopia: true});
  assert.equal(utopia.blackflow_start_reward_priority[0], 'pegasus');
  const opers = params('Roguelike', {...base, StartingOpers: [{Name: '甲', UseSupport: false}, {Name: '乙', UseSupport: true}], UseAdditionalStartingOpers: false});
  assert.deepEqual(opers.core_char_list, [{name: '甲', use_support: false}]);
  const named = params('Roguelike', {...base, StartingOpers: [{Name: 'alias', UseSupport: false}]}, {ctx: ctx({operatorName: n => n === 'alias' ? '正式名' : undefined})});
  assert.equal(named.core_char_list[0].name, '正式名');
});

test('neutral compile is time independent', () => {
  const g = {...defaultGui('Fight'), UseWeeklySchedule: true, WeeklySchedule: {Friday: false}, UseOptionalStage: true, StagePlan: ['CE-6', 'SK-5']};
  const neutral = {...ctx(), neutral: true};
  assert.equal(params('Fight', g, {ctx: neutral}).stage, 'CE-6');
});

test('activity catalog: open activity stage, 48h medicine extension', () => {
  const json = {Official: {sideStoryStage: {ev: {MinimumRequired: 'v6.0.0', Activity: {UtcStartTime: '2026/08/01 16:00:00', UtcExpireTime: '2026/08/08 04:00:00', TimeZone: 8}, Stages: [{Display: 'EV-8', Value: 'EV-8'}]}}}};
  const stages = new StageCatalog('Official', json);
  assert.equal(stages.isOpen('EV-8', 5, SAMPLE_TIME), true);
  assert.equal(stages.isOpen('EV-8', 5, new Date('2026-08-09T00:00:00Z')), false);
  const g = {...defaultGui('Fight'), UseExpireMedicineForActivity: true};
  // Expires 2026-08-07 20:00Z, < 2 days away; Friday → 3 days until the end of the game week.
  assert.equal(params('Fight', g, {ctx: ctx({stages})}).medicine_expire_days, 3);
});
