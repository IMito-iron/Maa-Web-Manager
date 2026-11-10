// Schema-driven form support: evaluates the Windows XAML CalcBinding conditions of
// form-spec.generated.ts against a GUI config, and describes the widget/choices of each field.
// ViewModel property names (the identifiers in the expressions) are mapped to config fields here;
// an identifier missing from BINDINGS throws, and the coverage test keeps the table complete.
import {FORM_SPEC, type SpecField} from './form-spec.generated';
import {PERMANENT_STAGE_OPTIONS} from './stages';
import {INT_MAX, type ClientType, type Gui, type GuiTaskType} from './types';

export interface FormEnv { client: ClientType; }

const ENUM_CLIENT: Record<ClientType, string> = {Official: 'Official', Bilibili: 'Bilibili', YoStarEN: 'EN', YoStarJP: 'JP', YoStarKR: 'KR', txwy: 'Txwy'};
const PROFESSIONAL = ['突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队'];
const oper = (g: Gui, i: number) => (Array.isArray(g.StartingOpers) ? g.StartingOpers[i] : undefined) ?? {};

const BINDINGS: Record<string, (g: Gui, env: FormEnv) => unknown> = {
  ClientType: (_, env) => ENUM_CLIENT[env.client],
  ConnectConfig: () => 'General',          // USB devices; never the PC connection
  'Run.Idle': () => true,
  'TaskSettingVisibilities.Guide': () => false,
  AccountSwitchEnabled: g => g.AccountSwitchEnabled,
  ChooseLevel3: g => g.Level3Choose, ChooseLevel4: g => g.Level4Choose, ChooseLevel6: g => g.Level6Choose,
  UseLevel3PreferTags: g => g.PreferTagEnabled,
  Level3RecruitmentPermitReserveEnabled: g => g.Level3RecruitmentPermitReserveEnabled,
  RefreshLevel3: g => g.RefreshLevel3, PreserveTagEnabled: g => g.PreserveTagEnabled,
  InfrastMode: g => g.Mode, FiammettaRecoveryEnabled: g => g.FiammettaRecoveryEnabled, UseWeeklySchedule: g => g.UseWeeklySchedule,
  UseStoneDisplay: g => g.UseStone !== false && g.UseStone !== undefined,
  IsSpecifiedInventoryLocked: () => false, IsSpecifiedDrops: g => g.EnableTargetDrop, HideSeries: g => g.HideSeries,
  CustomStageCode: g => g.IsStageManually, IsStageItemDragging: () => false,
  UseCustomAnnihilation: g => g.UseCustomAnnihilation, UseExpiringMedicine: g => g.UseExpiringMedicine,
  CreditVisitFriendsEnabled: g => g.VisitFriends, CreditFightTaskEnabled: g => g.CreditFight, CreditShopping: g => g.Shopping,
  RoguelikeMode: g => g.Mode, RoguelikeTheme: g => g.Theme,
  RoguelikeBlackFlowExpFlightActive: g => g.Theme === 'BlackFlow' && g.Mode === 'Exp' && !!g.BlackFlowFastFlight,
  RoguelikeEnableAdditionalCoreChars: g => g.UseAdditionalStartingOpers,
  RoguelikeCoreChar: g => oper(g, 0).Name ?? '', RoguelikeCoreChar2: g => oper(g, 1).Name ?? '', RoguelikeCoreChar3: g => oper(g, 2).Name ?? '',
  RoguelikeUseSupportUnit: g => !!oper(g, 0).UseSupport, RoguelikeCoreChar2UseSupport: g => !!oper(g, 1).UseSupport, RoguelikeCoreChar3UseSupport: g => !!oper(g, 2).UseSupport,
  RoguelikeInvestmentEnabled: g => g.Investment,
  RoguelikeSquadIsProfessional: g => g.Mode === 'Collectible' && g.Theme !== 'Phantom' && PROFESSIONAL.includes(g.Squad),
  RoguelikeSquadIsFoldartal: g => g.Mode === 'Collectible' && g.Theme === 'Sami' && g.Squad === '生活至上分队',
  RoguelikeStartWithEliteTwo: g => g.StartWithEliteTwo, RoguelikeOnlyStartWithEliteTwo: g => g.StartWithEliteTwoOnly,
  Roguelike3FirstFloorFoldartal: g => g.SamiFirstFloorFoldartal, Roguelike3NewSquad2StartingFoldartal: g => g.SamiNewSquad2StartingFoldartal,
  RoguelikeMonthlySquadAutoIterate: g => g.MonthlySquadAutoIterate, RoguelikeBlackFlowFastFlight: g => g.BlackFlowFastFlight,
  RoguelikeBlackFlowHasSerpent: g => [g.BlackFlowStartAnimal1, g.BlackFlowStartAnimal2].includes('FeatheredSerpent'),
  RoguelikeBlackFlowStartUtopiaAvailable: g => g.Difficulty === -1 || g.Difficulty >= 6,
  RoguelikeBlackFlowStartUtopia: g => g.BlackFlowStartUtopia,
};
export const knownBindings = () => Object.keys(BINDINGS);

// ------------------------------------------------------------------ CalcBinding expressions
type Tok = {t: 'id' | 'str' | 'op' | '(' | ')'; v: string};
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(==|!=|&&|\|\||!)|(\()|(\))|"([^"]*)"|([A-Za-z_][\w.:]*))/y;
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Cannot parse condition near "${src.slice(i)}"`);
    i = re.lastIndex;
    if (m[1]) out.push({t: 'op', v: m[1]});
    else if (m[2]) out.push({t: '(', v: '('});
    else if (m[3]) out.push({t: ')', v: ')'});
    else if (m[4] !== undefined) out.push({t: 'str', v: m[4]});
    else if (m[5] === 'and' || m[5] === 'or') out.push({t: 'op', v: m[5] === 'and' ? '&&' : '||'});
    else out.push({t: 'id', v: m[5]});
  }
  return out;
}

function evaluate(src: string, g: Gui, env: FormEnv): boolean {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const value = (tok: Tok): unknown => {
    if (tok.t === 'str') return tok.v;
    const enumLit = /^(?:task|enums|taskQueue_vms):\w+\.(\w+)$/.exec(tok.v);
    if (enumLit) return enumLit[1];
    const binding = BINDINGS[tok.v];
    if (!binding) throw new Error(`Unknown binding ${tok.v}`);
    return binding(g, env);
  };
  const primary = (): unknown => {
    const tok = toks[p++];
    if (!tok) throw new Error('Unexpected end of condition');
    if (tok.t === 'op' && tok.v === '!') return !truthy(primary());
    if (tok.t === '(') { const v = or(); p++; return v; }
    return value(tok);
  };
  const truthy = (v: unknown) => !!v;
  const cmp = (): unknown => {
    const left = primary();
    const tok = peek();
    if (tok?.t === 'op' && (tok.v === '==' || tok.v === '!=')) { p++; const right = primary(); return tok.v === '==' ? left === right : left !== right; }
    return left;
  };
  const and = (): boolean => { let v = truthy(cmp()); while (peek()?.v === '&&') { p++; v = truthy(cmp()) && v; } return v; };
  const or = (): boolean => { let v = and(); while (peek()?.v === '||') { p++; v = and() || v; } return v; };
  return or();
}

/** "Visibility: A && Visibility: B" — each clause must hold. */
export function condition(expr: string | null, g: Gui, env: FormEnv): boolean {
  if (!expr) return true;
  return expr.split(/\s*&&\s*(?=(?:Visibility|IsEnabled):)/).every(part => evaluate(part.replace(/^(?:Visibility|IsEnabled):\s*/, ''), g, env));
}
export const visible = (f: SpecField, g: Gui, env: FormEnv) => f.visible.some(e => condition(e, g, env));
export const enabled = (f: SpecField, g: Gui, env: FormEnv) => f.enabled.every(e => condition(e, g, env));

// ------------------------------------------------------------------ widgets and choices
export type Widget = 'bool' | 'number' | 'select' | 'text' | 'stringList' | 'flags' | 'ordered' | 'stagePlan' | 'rooms' | 'weekly' | 'opers' | 'recruitTime' | 'hidden';
export interface Choice { value: string | number | boolean; label: string; }

const WIDGET: Record<string, Widget> = {
  Level3Time: 'recruitTime', Level4Time: 'recruitTime', StagePlan: 'stagePlan', RoomList: 'rooms', WeeklySchedule: 'weekly',
  StartingOpers: 'opers', CollectibleStartAwards: 'flags', BlackFlowStartRewards: 'flags', BlackFlowStartRewardPriority: 'ordered',
  Level3PreferTags: 'stringList', PreserveTagList: 'stringList', Themes: 'stringList', Seed: 'text', DropId: 'text',
  // Run-only check box: never saved (Windows [JsonIgnore]); offered on manual runs instead.
  UseExpedited: 'hidden',
};

const ROGUE_MODE_NAME: Record<number, string> = {0: 'Exp', 1: 'Investment', 4: 'Collectible', 5: 'CLP_PDS', 6: 'Squad', 7: 'Exploration', 20001: 'FindPlaytime', 30003: 'BlackFlowStartRun'};
const DIFFICULTY_CAP: Record<string, number> = {Phantom: 15, Mizuki: 18, Sami: 15, Sarkaz: 18, JieGarden: 18, BlackFlow: 16};
const BLACKFLOW_REWARD_LABELS = ['UnnumberedItem', 'SurveyAdvance', 'SpaceLease', 'RegressionCompensation', 'ForestRide', 'NestParasitism', 'Pegasus', 'Hippogriff', 'Dragon', 'Hydra', 'BaiZe', 'GoldenCrow'];

export function widgetOf(f: SpecField): Widget {
  if (WIDGET[f.key]) return WIDGET[f.key];
  const c = f.controls[0];
  if (c === 'CheckBox') return 'bool';
  if (c === 'NumericUpDown' || c === 'Slider') return 'number';
  if (c === 'ComboBox' || c === 'RadioButton') return 'select';
  return 'text';
}

/** Select/flags options in GUI-config value space (enum names, not Core ints). */
export function choicesOf(type: GuiTaskType, f: SpecField, g: Gui): Choice[] {
  const raw = f.choices;
  if (type === 'Roguelike') {
    if (f.key === 'Mode') {
      const all = (raw as any[]).map(c => ({value: ROGUE_MODE_NAME[c.value], label: c.label}));
      // RoguelikeTaskUserControlModel.UpdateRoguelikeModeList: theme-specific modes.
      if (g.Theme === 'BlackFlow') return all.filter(c => ['Exp', 'Investment', 'BlackFlowStartRun'].includes(String(c.value)));
      return all.filter(c => c.value !== 'BlackFlowStartRun' && (c.value !== 'CLP_PDS' || g.Theme === 'Sami') && (c.value !== 'FindPlaytime' || g.Theme === 'JieGarden'));
    }
    if (f.key === 'Difficulty') {
      const cap = DIFFICULTY_CAP[g.Theme] ?? 15;
      return [{value: -1, label: '不切换'}, {value: INT_MAX, label: 'MAX'}, ...Array.from({length: cap}, (_, i) => ({value: cap - i, label: String(cap - i)})), {value: 0, label: 'MIN'}];
    }
    if (f.key === 'Squad' || f.key === 'SquadCollectible') {
      const by = raw?.byTheme ?? {};
      const themeKey = g.Theme === 'Sarkaz' && g.Mode === 'Investment' ? 'Sarkaz(Mode=Investment)' : g.Theme;
      const common: string[] = (by['_common(追加在主题分队之后)'] ?? []).map((s: string) => s.replace(/\(非黑流\)$/, '')).filter((s: string) => g.Theme !== 'BlackFlow' || s !== '高规格分队');
      return [...(by[themeKey] ?? []), ...common].map((s: string) => ({value: s, label: s}));
    }
    if (f.key === 'Roles') return (raw as any[]).filter(c => !/（界园\/黑流）/.test(c.label) || ['JieGarden', 'BlackFlow'].includes(g.Theme)).map(c => ({value: c.value, label: c.label}));
    if (f.key === 'FindPlaytimeTarget') return (raw as any[]).map(c => ({value: ({1: 'Ling', 2: 'Shu', 3: 'Nian'} as Record<number, string>)[c.value], label: c.label}));
    if (f.key === 'BlackFlowEnding') return [{value: 'Ending1', label: '结局1'}];
    if (f.key === 'BlackFlowStartAnimal1' || f.key === 'BlackFlowStartAnimal2') {
      return [['None', '无'], ['Cat', '襁褓猫'], ['Dog', '襁褓狗'], ['Cerberus', '襁褓三头犬'], ['FeatheredSerpent', '襁褓羽蛇']].map(([value, label]) => ({value, label}));
    }
    if (f.key === 'BlackFlowStartRewards' || f.key === 'BlackFlowStartRewardPriority') return BLACKFLOW_REWARD_LABELS.map(v => ({value: v, label: v}));
  }
  if (type === 'Infrast' && f.key === 'Mode') return (raw as any[]).map(c => ({value: String(c.value).replace(/\(.*\)$/, ''), label: c.label}));
  if (type === 'Infrast' && f.key === 'PlanSelect') return [{value: -1, label: '自动（按时间段）'}, ...[0, 1, 2, 3, 4, 5].map(i => ({value: i, label: `Plan ${String.fromCharCode(65 + i)}`}))];
  if (Array.isArray(raw)) return raw.map(c => ({value: c.value, label: c.label}));
  return [];
}

export const stageOptions = () => PERMANENT_STAGE_OPTIONS;

/**
 * Fields the schema lists without a control of their own. `Seed` feeds `start_with_seed` and is
 * only meaningful with "使用指定种子开局" (JieGarden); it gets an input next to that check box.
 */
const OVERRIDES: Record<string, Record<string, Partial<SpecField>>> = {
  Roguelike: {Seed: {label: '种子', group: '高级设置', visible: ['Visibility: RoguelikeTheme == task:RoguelikeTheme.JieGarden && Visibility: RoguelikeStartWithSeed']}},
};
BINDINGS.RoguelikeStartWithSeed = g => g.StartWithSeed;
export const specFor = (type: GuiTaskType): SpecField[] => (FORM_SPEC[type] ?? []).map(f => ({...f, ...(OVERRIDES[type]?.[f.key] ?? {})}));
export {FORM_SPEC, type SpecField};

/**
 * Side effects of the Windows ViewModel setters that change other fields:
 * - FightTaskUserControlModel.UseStone: enabling stone sets MedicineCount=999 and enables medicine.
 * - RoguelikeTaskUserControlModel theme/mode change: values missing from the new lists fall back
 *   (squad → 指挥分队, roles → 稳扎稳打, difficulty → -1), per gui-side-logic.md §7.
 */
export function applyUiRules(type: GuiTaskType, key: string, value: unknown, g: Gui, env: FormEnv): Gui {
  const next: Gui = {...g, [key]: value};
  if (type === 'Fight' && key === 'UseStone' && value) {
    next.MedicineCount = 999;
    if (next.UseMedicine === false) next.UseMedicine = true;
  }
  if (type === 'Roguelike' && (key === 'Theme' || key === 'Mode')) {
    const spec = specFor('Roguelike');
    const field = (k: string) => spec.find(f => f.key === k)!;
    const has = (k: string, v: unknown) => choicesOf('Roguelike', field(k), next).some(c => c.value === v);
    if (key === 'Theme' && !has('Mode', next.Mode)) next.Mode = 'Exp';
    if (next.Squad && !has('Squad', next.Squad)) next.Squad = '指挥分队';
    if (next.SquadCollectible && !has('SquadCollectible', next.SquadCollectible)) next.SquadCollectible = '指挥分队';
    if (next.Roles && !has('Roles', next.Roles)) next.Roles = '稳扎稳打';
    if (!has('Difficulty', next.Difficulty)) next.Difficulty = -1;
  }
  void env;
  return next;
}
