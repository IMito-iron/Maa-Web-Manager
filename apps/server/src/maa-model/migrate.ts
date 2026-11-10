// Legacy raw params → Windows GUI config, with a lossless check.
//
// A conversion is accepted only if the compiled result means the same thing to MaaCore v6.21.4 as
// the original params. "Means the same" compares *effective* values: a missing key takes the Core
// default (src/MaaCore/Task/Interface/*Task.cpp `params.get(key, default)`), deprecated keys are
// resolved the way Core resolves them, and keys Core does not read in the given mode are ignored.
// Missing keys are therefore migrated to the Core default, so converting never changes behaviour.
import {clientInfo} from './clients';
import {defaultGui, INFRAST_ROOMS, normalizeTags} from './defaults';
import {compileTask} from './compile';
import {neutralContext, stableStringify, taskInactive} from './preset';
import {clientOf as clientOfDocValue} from './clients';
import {INT_MAX, isGuiTaskType, type ClientType, type Gui, type GuiTaskType, type PresetSettings} from './types';

type P = Record<string, any>;
const has = (p: P, k: string) => Object.hasOwn(p, k);
const get = <T>(p: P, k: string, d: T): T => (has(p, k) ? p[k] : d);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s !== '') : []);

/** Effective Core view of a params object; keys absent from the result are not read by Core. */
export function effective(type: GuiTaskType, input: P): P {
  const p = input ?? {};
  switch (type) {
    case 'StartUp': return {start_game_enabled: get(p, 'start_game_enabled', false), account_name: get(p, 'account_name', '')};
    case 'Award': return Object.fromEntries(['award', 'mail', 'recruit', 'orundum', 'mining', 'specialaccess', 'signinevent']
      .map(k => [k, get(p, k, k === 'award')]));
    case 'Custom': return {task_names: get(p, 'task_names', [])};
    case 'SwitchTheme': return {themes: get(p, 'themes', [])};
    case 'Fight': {
      const expire = has(p, 'medicine_expire_days') ? p.medicine_expire_days : (has(p, 'expiring_medicine') ? (p.expiring_medicine === 0 ? 0 : 2) : 0);
      const e: P = {stage: get(p, 'stage', ''), medicine: get(p, 'medicine', 0), medicine_expire_days: expire, stone: get(p, 'stone', 0),
        times: get(p, 'times', INT_MAX), series: get(p, 'series', 1), DrGrandet: get(p, 'DrGrandet', false),
        report_to_penguin: get(p, 'report_to_penguin', false), report_to_yituliu: get(p, 'report_to_yituliu', false),
        server: get(p, 'server', 'CN'), drops: get(p, 'drops', {})};
      if (e.report_to_penguin) e.penguin_id = get(p, 'penguin_id', '');
      if (e.report_to_yituliu) e.yituliu_id = get(p, 'yituliu_id', '');
      return e;
    }
    case 'Recruit': {
      const rt = get<P>(p, 'recruitment_time', {});
      const clamp = (k: string) => Math.min(540, Math.max(60, typeof rt?.[k] === 'number' ? rt[k] : 540));
      const preserve = has(p, 'preserve_tags') ? p.preserve_tags : (has(p, 'skip_robot') && p.skip_robot ? ['支援机械'] : []);
      const e: P = {refresh: get(p, 'refresh', false), force_refresh: get(p, 'force_refresh', true), select: get(p, 'select', null), confirm: get(p, 'confirm', null),
        level3_recruitment_permit_reserve: get(p, 'level3_recruitment_permit_reserve', 0), times: get(p, 'times', 0), set_time: get(p, 'set_time', true),
        expedite: get(p, 'expedite', false), preserve_tags: preserve, extra_tags_mode: get(p, 'extra_tags_mode', 0), first_tags: get(p, 'first_tags', []),
        recruitment_time: {'3': clamp('3'), '4': clamp('4'), '5': clamp('5'), '6': clamp('6')},
        report_to_penguin: get(p, 'report_to_penguin', false), report_to_yituliu: get(p, 'report_to_yituliu', false), server: get(p, 'server', 'CN')};
      if (e.report_to_penguin) e.penguin_id = get(p, 'penguin_id', '');
      if (e.report_to_yituliu) e.yituliu_id = get(p, 'yituliu_id', '');
      return e;
    }
    case 'Infrast': {
      const mode: number = get<number>(p, 'mode', 0);
      const e: P = {mode, facility: get(p, 'facility', null), drones: get(p, 'drones', '_NotUse'), continue_training: get(p, 'continue_training', false),
        threshold: get(p, 'threshold', 0.3), dorm_notstationed_enabled: get(p, 'dorm_notstationed_enabled', false), dorm_trust_enabled: get(p, 'dorm_trust_enabled', false),
        replenish: get(p, 'replenish', false), reception_message_board: get(p, 'reception_message_board', true),
        reception_clue_exchange: get(p, 'reception_clue_exchange', true), reception_send_clue: get(p, 'reception_send_clue', true)};
      if (mode === 0) {
        e.fiammetta_recovery_enabled = get(p, 'fiammetta_recovery_enabled', false);
        if (e.fiammetta_recovery_enabled) e.fiammetta_targets = get(p, 'fiammetta_targets', []);
        for (const k of ['use_pinus_sylvestris', 'use_perception_information', 'use_worldly_plight', 'use_abyssal_hunter']) e[k] = get(p, k, false);
      }
      if (mode === 10000) { e.filename = get(p, 'filename', null); e.plan_index = get(p, 'plan_index', 0); }
      return e;
    }
    case 'Mall': {
      const shopping = get(p, 'shopping', true), credit = get(p, 'credit_fight', false);
      const e: P = {visit_friends: get(p, 'visit_friends', true), shopping, credit_fight: credit};
      if (shopping) {
        e.buy_first = strings(get(p, 'buy_first', []));
        e.blacklist = strings(get(p, 'blacklist', []));
        for (const k of ['only_buy_discount', 'reserve_max_credit', 'force_shopping_if_credit_full']) e[k] = get(p, k, false);
      }
      if (credit) e.formation_index = has(p, 'formation_index') ? p.formation_index : get(p, 'select_formation', 0);
      return e;
    }
    case 'Roguelike': {
      // Defaults from docs/zh-cn/protocol/integration.md (v6.21.4).
      const keys: Record<string, unknown> = {theme: 'Phantom', mode: 0, squad: '指挥分队', roles: '取长补短', use_nonfriend_support: false,
        starts_count: INT_MAX, difficulty: -1, stop_at_final_boss: false, stop_at_max_level: false, investment_enabled: true,
        refresh_trader_with_dice: false, start_with_elite_two: false, only_start_with_elite_two: false, collectible_mode_shopping: false,
        start_foldartal_list: [], expected_collapsal_paradigms: ['目空一些', '睁眼瞎', '图像损坏', '一抹黑']};
      const e: P = Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, get(p, k, d)]));
      if (e.investment_enabled) { e.investments_count = get(p, 'investments_count', INT_MAX); e.stop_when_investment_full = get(p, 'stop_when_investment_full', false); e.investment_with_more_score = get(p, 'investment_with_more_score', false); }
      // core_char + use_support was replaced by core_char_list.
      e.core_char_list = has(p, 'core_char_list') ? p.core_char_list : (p.core_char ? [{name: p.core_char, use_support: !!p.use_support}] : []);
      for (const k of Object.keys(p)) if (!(k in e) && !['core_char', 'use_support', 'investments_count', 'stop_when_investment_full', 'investment_with_more_score'].includes(k)) e[k] = p[k];
      return e;
    }
  }
}

/** Keys of the legacy params that the comparison does not model; their presence makes it lossy. */
const KNOWN: Record<GuiTaskType, string[]> = {
  StartUp: ['start_game_enabled', 'account_name', 'client_type', 'enable'],
  Award: ['award', 'mail', 'recruit', 'orundum', 'mining', 'specialaccess', 'signinevent', 'enable'],
  Custom: ['task_names', 'enable'], SwitchTheme: ['themes', 'enable'],
  Fight: ['stage', 'medicine', 'medicine_expire_days', 'expiring_medicine', 'stone', 'times', 'series', 'DrGrandet', 'report_to_penguin', 'penguin_id',
    'report_to_yituliu', 'yituliu_id', 'server', 'client_type', 'drops', 'enable'],
  Recruit: ['refresh', 'force_refresh', 'select', 'confirm', 'level3_recruitment_permit_reserve', 'times', 'set_time', 'expedite', 'expedite_times',
    'skip_robot', 'preserve_tags', 'extra_tags_mode', 'first_tags', 'recruitment_time', 'report_to_penguin', 'penguin_id', 'report_to_yituliu', 'yituliu_id', 'server', 'enable'],
  Infrast: ['mode', 'facility', 'drones', 'continue_training', 'threshold', 'dorm_notstationed_enabled', 'dorm_trust_enabled', 'replenish', 'reception_message_board',
    'reception_clue_exchange', 'reception_send_clue', 'fiammetta_targets', 'fiammetta_recovery_enabled', 'use_pinus_sylvestris', 'use_perception_information',
    'use_worldly_plight', 'use_abyssal_hunter', 'filename', 'plan_index', 'enable'],
  Mall: ['credit_fight', 'formation_index', 'select_formation', 'visit_friends', 'shopping', 'buy_first', 'blacklist', 'force_shopping_if_credit_full',
    'only_buy_discount', 'reserve_max_credit', 'enable'],
  Roguelike: [], // compared key by key in effective(); unknown keys are carried into the comparison
};

/** Best-effort inverse mapping; correctness is decided by the lossless check, not by this. */
export function inverse(type: GuiTaskType, p: P): Gui {
  const g = defaultGui(type);
  switch (type) {
    case 'StartUp': return {...g, AccountName: get(p, 'account_name', ''), AccountSwitchEnabled: !!get(p, 'account_name', '')};
    case 'Award': return {...g, Award: get(p, 'award', true), Mail: get(p, 'mail', false), FreeGacha: get(p, 'recruit', false), Orundum: get(p, 'orundum', false),
      Mining: get(p, 'mining', false), SpecialAccess: get(p, 'specialaccess', false), SignInEvent: get(p, 'signinevent', false)};
    case 'Custom': return {...g, CustomTaskName: (get<string[]>(p, 'task_names', [])).join(',')};
    case 'SwitchTheme': return {...g, Themes: get(p, 'themes', [])};
    case 'Fight': {
      const e = effective('Fight', p);
      const limited = e.times !== INT_MAX;
      const drop = e.drops && typeof e.drops === 'object' ? Object.entries(e.drops as Record<string, number>) : [];
      return {...g, StagePlan: [e.stage], UseMedicine: e.medicine > 0, MedicineCount: e.medicine, UseStone: false, StoneCount: e.stone,
        UseStoneAllowSave: e.stone > 0, ...(e.stone > 0 ? {UseStone: true} : {}),
        EnableTimesLimit: limited, TimesLimit: e.times, Series: e.series, IsDrGrandet: e.DrGrandet,
        UseExpiringMedicine: e.medicine_expire_days > 0, MedicineExpireDays: e.medicine_expire_days > 0 ? e.medicine_expire_days : 2,
        EnableTargetDrop: drop.length === 1, DropId: drop[0]?.[0] ?? '', DropCount: drop[0]?.[1] ?? 0,
        UseCustomAnnihilation: /@Annihilation$/.test(e.stage), AnnihilationStage: /@Annihilation$/.test(e.stage) ? e.stage : 'Annihilation',
        ...(/@Annihilation$/.test(e.stage) ? {StagePlan: ['Annihilation']} : {})};
    }
    case 'Recruit': {
      const e = effective('Recruit', p);
      const sel: number[] = Array.isArray(e.select) ? e.select : [], con: number[] = Array.isArray(e.confirm) ? e.confirm : [];
      return {...g, MaxTimes: e.times, RefreshLevel3: e.refresh, ForceRefresh: e.force_refresh, ExtraTagMode: e.extra_tags_mode,
        PreferTagEnabled: true, Level3PreferTags: normalizeTags(e.first_tags),
        PreserveTagEnabled: e.preserve_tags.length > 0, PreserveTagList: e.preserve_tags.length ? e.preserve_tags : ['支援机械'],
        Level3RecruitmentPermitReserveEnabled: e.level3_recruitment_permit_reserve > 0, Level3RecruitmentPermitReserve: e.level3_recruitment_permit_reserve > 0 ? e.level3_recruitment_permit_reserve : 8,
        Level3Choose: con.includes(3), Level4Choose: con.includes(4) && sel.includes(4), Level5Choose: con.includes(5) && sel.includes(5),
        Level6Choose: con.includes(6) && sel.includes(6), Level3Time: e.recruitment_time['3'], Level4Time: e.recruitment_time['4']};
    }
    case 'Infrast': {
      const e = effective('Infrast', p);
      const mode = ({0: 'Normal', 10000: 'Custom', 20000: 'Rotation'} as Record<number, string>)[e.mode] ?? 'Normal';
      const enabled: string[] = Array.isArray(e.facility) ? e.facility : [];
      const rest = INFRAST_ROOMS.filter(r => !enabled.includes(r));
      const t: string[] = Array.isArray(e.fiammetta_targets) ? e.fiammetta_targets : ['清流', '可露希尔', '但书'];
      return {...g, Mode: mode, UsesOfDrones: e.drones, DormThreshold: Math.round(e.threshold * 100), ContinueTraining: e.continue_training,
        DormFilterNotStationed: e.dorm_notstationed_enabled, DormTrustEnabled: e.dorm_trust_enabled, OriginiumShardAutoReplenishment: e.replenish,
        ReceptionMessageBoard: e.reception_message_board, ReceptionClueExchange: e.reception_clue_exchange, SendClue: e.reception_send_clue,
        FiammettaRecoveryEnabled: !!e.fiammetta_recovery_enabled, FiammettaTarget1: t[0] ?? '', FiammettaTarget2: t[1] ?? '', FiammettaTarget3: t[2] ?? '',
        UsePinusSylvestris: !!e.use_pinus_sylvestris, UsePerceptionInformation: !!e.use_perception_information,
        UseWorldlyPlight: !!e.use_worldly_plight, UseAbyssalHunter: !!e.use_abyssal_hunter,
        Filename: typeof e.filename === 'string' ? e.filename : '', PlanSelect: mode === 'Custom' ? e.plan_index : -1,
        RoomList: [...enabled.map(Room => ({Room, IsEnabled: true})), ...rest.map(Room => ({Room, IsEnabled: false}))]};
    }
    case 'Mall': {
      const e = effective('Mall', p);
      return {...g, VisitFriends: e.visit_friends, VisitFriendsOnceADay: false, Shopping: e.shopping, CreditFight: e.credit_fight, CreditFightOnceADay: false,
        CreditFightFormation: e.formation_index ?? 0, FirstList: (e.buy_first ?? []).join(';'), BlackList: (e.blacklist ?? []).join(';'),
        ShoppingIgnoreBlackListWhenFull: !!e.force_shopping_if_credit_full, OnlyBuyDiscount: !!e.only_buy_discount, ReserveMaxCredit: !!e.reserve_max_credit};
    }
    case 'Roguelike': {
      const e = effective('Roguelike', p);
      const MODE: Record<number, string> = {0: 'Exp', 1: 'Investment', 4: 'Collectible', 5: 'CLP_PDS', 6: 'Squad', 7: 'Exploration', 20001: 'FindPlaytime', 30003: 'BlackFlowStartRun'};
      const chars = Array.isArray(e.core_char_list) ? e.core_char_list : [];
      return {...g, Theme: e.theme, Mode: MODE[e.mode] ?? 'Exp', Difficulty: e.difficulty, Squad: e.squad, Roles: e.roles, StartCount: e.starts_count,
        StartingOpers: chars.map((c: any) => ({Name: String(c?.name ?? ''), UseSupport: !!c?.use_support})), UseAdditionalStartingOpers: chars.length > 1,
        Investment: e.investment_enabled, InvestCount: e.investments_count ?? 999, StopWhenDepositFull: !!e.stop_when_investment_full,
        InvestWithMoreScore: !!e.investment_with_more_score, UseSupportNonFriend: e.use_nonfriend_support, RefreshTraderWithDice: e.refresh_trader_with_dice,
        StopAtFinalBoss: e.stop_at_final_boss, StopWhenLevelMax: e.stop_at_max_level, StartWithEliteTwo: e.start_with_elite_two,
        StartWithEliteTwoOnly: e.only_start_with_elite_two, CollectibleShopping: e.collectible_mode_shopping};
    }
  }
}

export interface Difference { key: string; before: unknown; after: unknown; }
export interface Migration { gui: Gui; lossless: boolean; differences: Difference[]; }

/** Settings implied by a legacy preset (used to compile Fight/Recruit for the comparison). */
export function inferSettings(doc: any): PresetSettings {
  const tasks: any[] = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const first = (key: string) => tasks.map(t => t?.params ?? {}).find(p => Object.hasOwn(p, key))?.[key];
  const startup = tasks.find(t => t?.type === 'StartUp')?.params;
  return {
    StartGame: doc?.startup === true || (startup ? startup.start_game_enabled === true : true),
    ReportToPenguin: first('report_to_penguin') === true,
    PenguinId: typeof first('penguin_id') === 'string' ? first('penguin_id') : '',
    ReportToYituliu: first('report_to_yituliu') === true,
  };
}

export function migrateTask(type: GuiTaskType, params: P, client: ClientType, settings: PresetSettings, enabledFights: Gui[] = [], extraIgnored: string[] = []): Migration {
  const p = params ?? {};
  const gui = inverse(type, p);
  const differences: Difference[] = [];
  for (const key of Object.keys(p)) {
    if (KNOWN[type].length && !KNOWN[type].includes(key)) differences.push({key, before: p[key], after: undefined});
  }
  if (has(p, 'enable') && p.enable !== true) differences.push({key: 'enable', before: p.enable, after: undefined});
  const result = compileTask({type, gui, index: 0, client, settings, ctx: neutralContext(client), enabledFights, stateKey: ''});
  if (result.kind !== 'append') differences.push({key: '(task)', before: 'runs', after: result.reason});
  else {
    const before = effective(type, p), after = effective(type, result.params);
    // maa-cli overwrites client_type of StartUp/Fight/CloseDown; Core never reads it elsewhere.
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (extraIgnored.includes(key)) continue;
      if (stableStringify(before[key]) !== stableStringify(after[key])) differences.push({key, before: before[key], after: after[key]});
    }
  }
  return {gui, lossless: differences.length === 0, differences};
}

/** The server a client maps to, for explaining `server` differences. */
export const serverOf = (client: ClientType) => clientInfo(client).server;

/** Per-task migration report for a legacy preset; `null` for task types without a GUI model. */
export function migratePreset(doc: any): {settings: PresetSettings; tasks: (Migration | null)[]} {
  const client = clientOfDoc(doc);
  const settings = inferSettings(doc);
  const tasks: any[] = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const fights = tasks.filter(t => t?.type === 'Fight' && !taskInactive(t)).map(t => inverse('Fight', t.params ?? {}));
  return {settings, tasks: tasks.map(task => {
    if (!isGuiTaskType(task?.type)) return null;
    if (Array.isArray(task.variants) && task.variants.length && !taskInactive(task)) {
      return {gui: inverse(task.type, task.params ?? {}), lossless: false, differences: [{key: 'variants', before: task.variants, after: undefined}]};
    }
    let params = task.params ?? {};
    // maa-cli: top-level startup=true forces start_game_enabled on an explicit StartUp.
    if (task.type === 'StartUp' && doc?.startup === true) params = {...params, start_game_enabled: true};
    return migrateTask(task.type, params, client, settings, task.type === 'Mall' ? fights : []);
  })};
}
const clientOfDoc = (doc: any) => clientOfDocValue(doc?.client_type);
