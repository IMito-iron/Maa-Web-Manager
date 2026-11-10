// GUI configuration → Core task params, one function per task. Each mirrors the v6.21.4 sources:
// `ViewModels/UserControl/TaskQueue/<X>TaskUserControlModel.cs#ISerialize.Serialize` (gating) and
// `Models/AsstTasks/Asst<X>Task.cs#Serialize` (key set, order and omission rules).
import {clientInfo, gameDate, gameDayOfWeek, localMinutes} from './clients';
import {INFRAST_ROOMS, normalizeGui, normalizeTags} from './defaults';
import {INT_MAX, WEEK_DAYS, type ClientType, type Gui, type GuiTaskType, type PresetSettings, type RunOverrides, type RuntimeContext, type TaskCompile} from './types';

export interface CompileInput {
  type: GuiTaskType;
  gui: Gui;
  index: number;
  client: ClientType;
  settings: PresetSettings;
  ctx: RuntimeContext;
  /** Enabled Fight GUI configs of the same preset (Mall credit-fight conflict). */
  enabledFights: Gui[];
  /** Stable key for per-task persisted state (Mall once-a-day). */
  stateKey: string;
}

const append = (type: string, params: Record<string, unknown>, notes: string[] = []): TaskCompile => ({kind: 'append', type, params, notes});
const skip = (reason: string, notes: string[] = []): TaskCompile => ({kind: 'skip', reason, notes});
const fail = (reason: string, notes: string[] = []): TaskCompile => ({kind: 'error', reason, notes});

/** Tri-state `bool?`: `!= false` with the run-only value (Windows null) applied when present. */
function tri(gui: Gui, key: keyof RunOverrides, overrides: RunOverrides | undefined): boolean {
  const once = overrides?.[key];
  if (once === true) return true;           // null (this run only) counts as enabled
  return gui[key] !== false && gui[key] !== undefined;
}

function weeklySkipped(g: Gui, input: CompileInput): boolean {
  if (input.ctx.neutral || !g.UseWeeklySchedule) return false;
  const day = WEEK_DAYS[gameDayOfWeek(input.ctx.now, input.client)];
  return g.WeeklySchedule?.[day] === false;
}

// ---------------------------------------------------------------- StartUp
function startUp(g: Gui, input: CompileInput): TaskCompile {
  // StartUpTaskUserControlModel: PC connections never apply here (USB devices only).
  const accountName = clientInfo(input.client).accountSwitch && g.AccountSwitchEnabled === true ? String(g.AccountName ?? '') : '';
  const params: Record<string, unknown> = {start_game_enabled: input.settings.StartGame};
  if (accountName !== '') params.account_name = accountName; // DefaultValueHandling.Ignore
  params.client_type = input.client;
  return append('StartUp', params);
}

// ---------------------------------------------------------------- Recruit
function recruit(g: Gui, input: CompileInput): TaskCompile {
  const s = input.settings;
  const expedite = tri(g, 'UseExpedited', input.ctx.overrides?.(input.index));
  const select: number[] = [], confirm: number[] = [];
  if (g.Level3Choose) confirm.push(3);
  if (g.Level4Choose) { select.push(4); confirm.push(4); }
  if (g.Level5Choose) { select.push(5); confirm.push(5); }
  if (g.Level6Choose) { select.push(6); confirm.push(6); }
  const params: Record<string, unknown> = {
    refresh: !!g.RefreshLevel3,
    force_refresh: !!g.ForceRefresh,
    select, confirm,
    level3_recruitment_permit_reserve: g.Level3RecruitmentPermitReserveEnabled ? g.Level3RecruitmentPermitReserve : 0,
    times: g.MaxTimes,
    set_time: true,
    expedite,
    preserve_tags: g.PreserveTagEnabled ? normalizeTags(g.PreserveTagList) : [],
    extra_tags_mode: g.ExtraTagMode,
    first_tags: g.PreferTagEnabled ? normalizeTags(g.Level3PreferTags) : [],
    recruitment_time: {'3': g.Level3Time, '4': g.Level4Time, '5': 540, '6': 540},
    report_to_penguin: s.ReportToPenguin,
    report_to_yituliu: s.ReportToYituliu,
    server: clientInfo(input.client).server,
  };
  if (expedite) params.expedite_times = g.MaxTimes;
  const notes = expedite ? ['本次运行临时启用：UseExpedited'] : [];
  if (s.ReportToPenguin) params.penguin_id = s.PenguinId;
  if (s.ReportToYituliu) params.yituliu_id = ''; // YituliuId is never assigned in v6.21.4
  return append('Recruit', params, notes);
}

// ---------------------------------------------------------------- Infrast
const INFRAST_MODE: Record<string, number> = {Normal: 0, Custom: 10000, Rotation: 20000};

function infrast(g: Gui, input: CompileInput): TaskCompile {
  if (weeklySkipped(g, input)) return skip('基建周计划：今日不执行');
  const mode = INFRAST_MODE[g.Mode] ?? 0;
  const rooms: {Room: string; IsEnabled: boolean}[] = Array.isArray(g.RoomList) ? g.RoomList : [];
  const ordered = mode === 0 ? [...rooms].sort((a, b) => INFRAST_ROOMS.indexOf(a.Room as any) - INFRAST_ROOMS.indexOf(b.Room as any)) : rooms;
  const targets = [...new Set([g.FiammettaTarget1, g.FiammettaTarget2, g.FiammettaTarget3].filter(t => typeof t === 'string' && t.trim() !== ''))].slice(0, 3);
  const params: Record<string, unknown> = {
    // RoomInfo(IsEnabled = true): gui.new.json omits the field for enabled rooms.
    facility: ordered.filter(r => r.IsEnabled !== false).map(r => r.Room),
    drones: g.UsesOfDrones,
    continue_training: !!g.ContinueTraining,
    threshold: g.DormThreshold / 100,
    dorm_notstationed_enabled: !!g.DormFilterNotStationed,
    dorm_trust_enabled: !!g.DormTrustEnabled,
    replenish: !!g.OriginiumShardAutoReplenishment,
    reception_message_board: !!g.ReceptionMessageBoard,
    reception_clue_exchange: !!g.ReceptionClueExchange,
    reception_send_clue: !!g.SendClue,
    fiammetta_targets: targets,
    fiammetta_recovery_enabled: !!g.FiammettaRecoveryEnabled,
    use_pinus_sylvestris: !!g.UsePinusSylvestris,
    use_perception_information: !!g.UsePerceptionInformation,
    use_worldly_plight: !!g.UseWorldlyPlight,
    use_abyssal_hunter: !!g.UseAbyssalHunter,
    mode,
  };
  if (mode !== 10000) return append('Infrast', params);

  const notes: string[] = [];
  // Built-in presets: the GUI points Filename at resource/custom_infrast/<file>.
  const filename = g.CustomFileType && g.CustomFileType !== 'user_defined'
    ? (input.ctx.builtinInfrastPath?.(g.CustomFileType) ?? `resource/custom_infrast/${g.CustomFileType}`)
    : String(g.Filename ?? '');
  params.filename = filename;
  let planSelect: number = Number.isInteger(g.PlanSelect) ? g.PlanSelect : -1;
  if (input.ctx.neutral || !input.ctx.infrastPlans) {
    params.plan_index = planSelect >= 0 ? planSelect : 0;
    return append('Infrast', params, notes);
  }
  // InfrastTask.OnDeserialized + Serialize
  const read = filename ? input.ctx.infrastPlans(filename) : {ok: false as const, missing: true};
  const plans = read.ok ? read.plans : [];
  if (!read.ok && !read.missing) planSelect = 0;
  if (read.ok && planSelect >= plans.length) planSelect = 0;
  if (planSelect < -1) planSelect = -1;
  if (planSelect !== -1 && plans.length <= planSelect) return fail('自定义基建计划序号超出范围');
  if (planSelect >= 0) params.plan_index = planSelect;
  else {
    const now = localMinutes(input.ctx.now, input.ctx.localTimeZone);
    const minutes = (hhmm: string) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
    const plan = plans.find(p => p.period.some(([a, b]) => minutes(a) <= now && now <= minutes(b)));
    if (plan) params.plan_index = plan.index;
    else { params.plan_index = 0; notes.push('自定义基建：当前时间没有匹配的计划，使用第 1 个计划'); }
  }
  return append('Infrast', params, notes);
}

// ---------------------------------------------------------------- Fight
/** FightTaskUserControlModel.GetFightStage: first stage open on the current game day. */
function fightStage(plan: string[], day: number, ctx: RuntimeContext): string | null {
  if (ctx.neutral) return plan.length ? plan[0] : null;
  return plan.find(s => ctx.stages.isOpen(s, day, ctx.now)) ?? null;
}

/** StageResetMode (UpdateStageList): unknown stages become "" when the list is known. */
function effectivePlan(g: Gui, ctx: RuntimeContext): string[] {
  const plan: string[] = Array.isArray(g.StagePlan) ? g.StagePlan.map((s: unknown) => String(s ?? '')) : [''];
  if (ctx.neutral || g.IsStageManually || g.StageResetMode !== 'Current' || !ctx.stages.hasActivityData) return plan;
  return plan.map(s => s === '' || ctx.stages.knows(s) ? s : '');
}

function fight(g: Gui, input: CompileInput): TaskCompile {
  const {ctx, settings: s} = input;
  if (weeklySkipped(g, input)) return skip('理智作战周计划：今日不执行');
  const day = gameDayOfWeek(ctx.now, input.client);
  const plan = effectivePlan(g, ctx);
  let stage = fightStage(plan, day, ctx);
  if (stage === null) return plan.length === 0 ? skip('关卡列表为空') : skip('备选关卡今日均未开放');
  const notes: string[] = [];
  const given = ctx.overrides?.(input.index);
  const overrides: RunOverrides | undefined = given ? {...given} : undefined;
  if (overrides?.UseStone) {
    // FightTaskUserControlModel.UseStone setter: enabling stone (also as null = this run only)
    // sets MedicineCount=999 and enables medicine with the same value.
    g = {...g, MedicineCount: 999};
    if (g.UseMedicine === false) overrides.UseMedicine = true;
  }
  if (overrides && Object.values(overrides).some(Boolean)) notes.push(`本次运行临时启用：${Object.keys(overrides).filter(k => (overrides as any)[k]).join('、')}`);
  const targetDrop = tri(g, 'EnableTargetDrop', overrides);
  if (targetDrop && g.IsInventoryTarget) {
    // No depot snapshot is available to the Manager: Windows skips with a warning in that case.
    return skip('指定材料（目标库存）需要仓库识别数据，当前没有库存数据，跳过');
  }
  const maxTimes = tri(g, 'EnableTimesLimit', overrides) ? g.TimesLimit : INT_MAX;
  let activityDays = 0;
  if (!ctx.neutral && g.UseExpireMedicineForActivity && ctx.stages.activityExpiresWithin2Days(ctx.now)) {
    const dow = gameDayOfWeek(new Date(ctx.now.getTime()), input.client);
    activityDays = ((7 - dow + 7) % 7) + 1; // days until the end of the (game) week
  }
  const expireDays = g.UseExpiringMedicine ? g.MedicineExpireDays : 0;
  if (stage === 'Annihilation' && g.UseCustomAnnihilation) stage = g.AnnihilationStage;
  const params: Record<string, unknown> = {
    stage,
    medicine: tri(g, 'UseMedicine', overrides) ? g.MedicineCount : 0,
    medicine_expire_days: Math.max(expireDays, activityDays),
    stone: tri(g, 'UseStone', overrides) ? g.StoneCount : 0,
    times: maxTimes,
    series: g.Series,
    DrGrandet: !!g.IsDrGrandet,
    report_to_penguin: s.ReportToPenguin,
  };
  if (s.ReportToPenguin && s.PenguinId.trim() !== '') params.penguin_id = s.PenguinId;
  params.report_to_yituliu = s.ReportToYituliu; // yituliu_id: YituliuId is empty → removed
  params.server = clientInfo(input.client).server;
  if (targetDrop && g.DropId && g.DropCount > 0) params.drops = {[g.DropId]: g.DropCount};
  params.client_type = input.client;
  if (maxTimes > 0 && maxTimes < INT_MAX && g.Series > 0 && maxTimes % g.Series !== 0) notes.push(`指定次数 ${maxTimes} 不是代理倍率 ${g.Series} 的整数倍，可能无法全部完成`);
  return append('Fight', params, notes);
}

// ---------------------------------------------------------------- Mall
function mall(g: Gui, input: CompileInput): TaskCompile {
  const {ctx} = input;
  const history = ctx.neutral ? {} : (ctx.mallHistory?.(input.stateKey) ?? {});
  const today = gameDate(ctx.now, input.client);
  const available = (enabled: boolean, onceADay: boolean, last?: string) => !onceADay ? enabled : ((!last || today > last) && enabled);
  // A Fight that resolves to "" (current/last) on any of its days would be rerouted by OF-1.
  const stageEmpty = input.enabledFights.some(f => {
    const fg = normalizeGui('Fight', f);
    const days = WEEK_DAYS.map((_, i) => i).filter(d => !fg.UseWeeklySchedule || fg.WeeklySchedule?.[WEEK_DAYS[d]] === true);
    return days.some(day => {
      const plan: string[] = fg.StagePlan;
      const found = plan.find(s => ctx.stages.isOpen(s, day, ctx.now)) ?? plan[0];
      return found === '';
    });
  });
  const creditFight = available(!!g.CreditFight, !!g.CreditFightOnceADay, history.creditFight);
  const notes = creditFight && stageEmpty ? ['借助战打 OF-1 会改变“当前/上次”关卡，队列中有使用“当前/上次”的理智作战，本次不打 OF-1'] : [];
  const split = (text: unknown) => String(text ?? '').split(';').map(v => v.trim());
  return append('Mall', {
    credit_fight: creditFight && !stageEmpty,
    formation_index: g.CreditFightFormation,
    visit_friends: available(!!g.VisitFriends, !!g.VisitFriendsOnceADay, history.visitFriends),
    shopping: !!g.Shopping,
    buy_first: split(g.FirstList),
    blacklist: [...new Set([...split(g.BlackList), ...clientInfo(input.client).blacklist])], // LINQ Union
    force_shopping_if_credit_full: !!g.ShoppingIgnoreBlackListWhenFull,
    only_buy_discount: !!g.OnlyBuyDiscount,
    reserve_max_credit: !!g.ReserveMaxCredit,
  }, notes);
}

// ---------------------------------------------------------------- Award / Custom / SwitchTheme
const award = (g: Gui): TaskCompile => append('Award', {
  award: !!g.Award, mail: !!g.Mail, recruit: !!g.FreeGacha, orundum: !!g.Orundum, mining: !!g.Mining,
  specialaccess: !!g.SpecialAccess, signinevent: !!g.SignInEvent,
});

const custom = (g: Gui): TaskCompile => append('Custom', {
  // Split(',', RemoveEmptyEntries) then Trim: whitespace-only entries survive as "".
  task_names: String(g.CustomTaskName ?? '').split(',').filter(v => v !== '').map(v => v.trim()),
});

const switchTheme = (g: Gui): TaskCompile => {
  const themes = Array.isArray(g.Themes) ? g.Themes.map(String) : [];
  return themes.length === 0 ? skip('未填写主题名，跳过更换主题') : append('SwitchTheme', {themes});
};

// ---------------------------------------------------------------- Roguelike
const ROGUE_MODE: Record<string, number> = {Exp: 0, Investment: 1, Collectible: 4, CLP_PDS: 5, Squad: 6, Exploration: 7, FindPlaytime: 20001, BlackFlowBabyAnimal: 30001, BlackFlowStartRun: 30003};
const PLAYTIME: Record<string, number> = {Unknown: 0, Ling: 1, Shu: 2, Nian: 3};
const ANIMAL: Record<string, string> = {Cat: 'swaddled_cat', Dog: 'swaddled_dog', Cerberus: 'swaddled_cerberus', FeatheredSerpent: 'swaddled_feathered_serpent'};
export const BLACKFLOW_REWARD_BITS: Record<string, number> = {
  UnnumberedItem: 1, SurveyAdvance: 2, SpaceLease: 4, RegressionCompensation: 8, ForestRide: 16, NestParasitism: 32,
  Pegasus: 64, Hippogriff: 128, Dragon: 256, Hydra: 512, BaiZe: 1024, GoldenCrow: 2048,
};
const SERPENT_REWARDS = 64 | 128 | 256 | 512 | 1024 | 2048;
/** [Flags] enums: an array of names, or System.Text.Json's "A, B" string ("None" = empty). */
export function flagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/[,|]/).map(v => v.trim()).filter(v => v && v !== 'None');
  return [];
}
const snake = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const COLLECTIBLE_KEYS: [string, string][] = [['HotWater', 'hot_water'], ['Shield', 'shield'], ['Ingot', 'ingot'], ['Hope', 'hope'], ['Random', 'random'], ['Key', 'key'], ['Dice', 'dice'], ['Idea', 'ideas'], ['Ticket', 'ticket']];
const PROFESSIONAL = ['突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队'];

function roguelike(g: Gui, input: CompileInput): TaskCompile {
  const theme = String(g.Theme), modeName = String(g.Mode), mode = ROGUE_MODE[modeName] ?? 0;
  const opers: {Name: string; UseSupport: boolean}[] = (Array.isArray(g.StartingOpers) ? g.StartingOpers : []);
  const starting = (g.UseAdditionalStartingOpers ? opers : opers.slice(0, 1));
  const cut = starting.findIndex(o => !o?.Name);
  const chosen = cut < 0 ? starting : starting.slice(0, cut);
  const professional = modeName === 'Collectible' && theme !== 'Phantom' && PROFESSIONAL.includes(g.Squad);
  const foldartalSquad = modeName === 'Collectible' && theme === 'Sami' && g.Squad === '生活至上分队';
  const mizukiOrSami = theme === 'Mizuki' || theme === 'Sami';
  const investmentCount = modeName === 'Investment' ? g.InvestCount : INT_MAX;
  const expFlight = theme === 'BlackFlow' && modeName === 'Exp' && !!g.BlackFlowFastFlight;
  const startRunFlight = theme === 'BlackFlow' && modeName === 'BlackFlowStartRun' && !!g.BlackFlowStartRunFastFlight;
  const p: Record<string, unknown> = {mode, theme, difficulty: g.Difficulty, starts_count: g.StartCount, investment_enabled: !!g.Investment};
  if (theme === 'BlackFlow' && modeName === 'Exp' && !g.BlackFlowFastFlight) {
    p.blackflow_strategy = ({Ending2: 'ending2', Ending3: 'ending3'} as Record<string, string>)[g.BlackFlowEnding] ?? 'ending1';
  }
  if (theme === 'BlackFlow' && modeName === 'BlackFlowStartRun') {
    const animals = [g.BlackFlowStartAnimal1, g.BlackFlowStartAnimal2].filter(a => a && a !== 'None' && ANIMAL[a]);
    const flags = flagsOf(g.BlackFlowStartRewards).reduce((n: number, r: string) => n | (BLACKFLOW_REWARD_BITS[r] ?? 0), 0);
    p.blackflow_start_animals = animals.map(a => ANIMAL[a]);
    p.blackflow_start_rewards = animals.includes('FeatheredSerpent') ? flags : flags & ~SERPENT_REWARDS;
    p.collectible_mode_squad = startRunFlight ? '特勤分队' : g.SquadCollectible;
    if (startRunFlight) {
      p.collectible_mode_roles = '稳扎稳打';
      p.collectible_mode_core_char_list = [{name: '机械师', use_support: false}];
    }
    // IsBlackFlowStartUtopiaDifficulty: -1 or >= 6
    if (g.BlackFlowStartUtopia && (g.Difficulty === -1 || g.Difficulty >= 6)) {
      p.blackflow_start_utopia = true;
      p.blackflow_start_reward_priority = (g.BlackFlowStartRewardPriority as string[]).filter(r => r in BLACKFLOW_REWARD_BITS).map(snake);
    }
  }
  if (g.Investment) {
    p.investment_with_more_score = theme !== 'BlackFlow' && !!g.InvestWithMoreScore && modeName === 'Investment';
    p.investments_count = investmentCount;
    p.stop_when_investment_full = !!g.StopWhenDepositFull && modeName === 'Investment';
  }
  if (expFlight) p.squad = '特勤分队'; else if (g.Squad) p.squad = g.Squad;
  if (expFlight) p.roles = '稳扎稳打'; else if (g.Roles) p.roles = g.Roles;
  const notes: string[] = [];
  const coreChars = expFlight ? [{name: '机械师', use_support: false}]
    : chosen.map(o => {
      const official = input.ctx.operatorName?.(o.Name);
      // Roguelike.StartingCoreChar.NotFound: Windows keeps the typed name when it is not in battle_data.
      if (input.ctx.operatorName && official === undefined) notes.push(`开局干员「${o.Name}」未在 battle_data 中，按原样下发`);
      return {name: official ?? o.Name, use_support: !!o.UseSupport};
    });
  if (coreChars.length) p.core_char_list = coreChars;
  if (modeName === 'Exp') {
    p.stop_at_final_boss = !!g.StopAtFinalBoss;
    p.stop_at_max_level = !!g.StopWhenLevelMax;
  } else if (modeName === 'Collectible') {
    p.collectible_mode_shopping = !!g.CollectibleShopping;
    p.collectible_mode_squad = g.SquadCollectible;
    p.start_with_elite_two = !!g.StartWithEliteTwo && professional && mizukiOrSami;
    p.only_start_with_elite_two = !!g.StartWithEliteTwoOnly && mizukiOrSami;
    const onlyElite = !!g.StartWithEliteTwoOnly && !!g.StartWithEliteTwo && professional;
    const awards = flagsOf(g.CollectibleStartAwards);
    p.collectible_mode_start_list = onlyElite ? {} : Object.fromEntries(COLLECTIBLE_KEYS.map(([flag, key]) => [key, awards.includes(flag)]));
  }
  if (modeName === 'Squad') { p.monthly_squad_auto_iterate = !!g.MonthlySquadAutoIterate; p.monthly_squad_check_comms = !!g.MonthlySquadCheckComms; }
  if (modeName === 'Exploration') p.deep_exploration_auto_iterate = !!g.DeepExplorationAutoIterate;
  if (modeName === 'FindPlaytime') p.find_playTime_target = PLAYTIME[g.FindPlaytimeTarget] ?? 1;
  if (theme === 'Sami' && modeName === 'Collectible' && g.SamiFirstFloorFoldartal && String(g.SamiFirstFloorFoldartals ?? '').length > 0) p.first_floor_foldartal = g.SamiFirstFloorFoldartals;
  const startFoldartals = String(g.SamiNewSquad2StartingFoldartals ?? '').split(';').filter(v => v !== '').slice(0, 3);
  if (g.SamiNewSquad2StartingFoldartal && foldartalSquad && startFoldartals.length) p.start_foldartal_list = startFoldartals;
  const paradigms = String(g.ExpectedCollapsalParadigms ?? '').split(';').filter(v => v !== '');
  if (modeName === 'CLP_PDS' && paradigms.length) p.expected_collapsal_paradigms = paradigms;
  p.use_nonfriend_support = !!g.UseSupportNonFriend;
  p.refresh_trader_with_dice = theme === 'Mizuki' && !!g.RefreshTraderWithDice;
  if (g.StartWithSeed && g.Seed) p.start_with_seed = g.Seed;
  return append('Roguelike', p, notes);
}

/**
 * Note on Collectible + "only elite two": Windows leaves `collectible_mode_start_list` as an empty
 * object (the reward loop is skipped, the dictionary is still serialised), reproduced above.
 */
export function compileTask(input: CompileInput): TaskCompile {
  const g = normalizeGui(input.type, input.gui);
  switch (input.type) {
    case 'StartUp': return startUp(g, input);
    case 'Recruit': return recruit(g, input);
    case 'Infrast': return infrast(g, input);
    case 'Fight': return fight(g, input);
    case 'Mall': return mall(g, input);
    case 'Award': return award(g);
    case 'Roguelike': return roguelike(g, input);
    case 'Custom': return custom(g);
    case 'SwitchTheme': return switchTheme(g);
  }
}
