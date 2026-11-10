// Windows default GUI configuration per task: MaaWpfGui v6.21.4 `Configuration/Single/MaaTask/*.cs`
// (property initialisers). Localised defaults use the zh-cn strings (Mall.HighPriorityDefault etc.).
import {INT_MAX, WEEK_DAYS, type Gui, type GuiTaskType} from './types';

export const INFRAST_ROOMS = ['Mfg', 'Trade', 'Control', 'Power', 'Reception', 'Office', 'Recycle', 'Dorm', 'Processing', 'Training', 'AssistantChange'] as const;
export const allWeek = () => Object.fromEntries(WEEK_DAYS.map(d => [d, true]));

/** RoguelikeTask._defaultBlackFlowStartRewardPriority */
export const BLACKFLOW_REWARD_PRIORITY = ['Pegasus', 'SpaceLease', 'ForestRide', 'UnnumberedItem', 'RegressionCompensation', 'SurveyAdvance',
  'NestParasitism', 'Hippogriff', 'Dragon', 'Hydra', 'BaiZe', 'GoldenCrow'];

const DEFAULTS: Record<GuiTaskType, () => Gui> = {
  StartUp: () => ({AccountName: '', AccountSwitchEnabled: false}),
  Award: () => ({Award: true, Mail: false, FreeGacha: false, Orundum: false, Mining: false, SpecialAccess: false, SignInEvent: false}),
  Custom: () => ({CustomTaskName: ''}),
  SwitchTheme: () => ({Themes: []}),
  Recruit: () => ({
    MaxTimes: 4, ExtraTagMode: 0, Level3PreferTags: [], PreferTagEnabled: true, PreserveTagList: ['支援机械'], PreserveTagEnabled: false,
    RefreshLevel3: true, ForceRefresh: true, Level3Choose: true, Level3RecruitmentPermitReserveEnabled: false, Level3RecruitmentPermitReserve: 8,
    Level4Choose: true, Level5Choose: false, Level6Choose: false, Level3Time: 540, Level4Time: 540,
  }),
  Mall: () => ({
    Shopping: true, CreditFight: false, CreditFightFormation: 0, CreditFightOnceADay: true, VisitFriends: true, VisitFriendsOnceADay: false,
    FirstList: '招聘许可', BlackList: '碳;家具;加急许可', ShoppingIgnoreBlackListWhenFull: false, OnlyBuyDiscount: false, ReserveMaxCredit: false,
  }),
  Fight: () => ({
    UseMedicine: false, MedicineCount: 0, UseStone: false, StoneCount: 0, EnableTargetDrop: false, DropId: '', DropCount: 0, IsInventoryTarget: false,
    EnableTimesLimit: false, TimesLimit: INT_MAX, Series: 0, StagePlan: [''], IsDrGrandet: false, UseExpiringMedicine: false, MedicineExpireDays: 2,
    UseExpireMedicineForActivity: false, UseCustomAnnihilation: false, AnnihilationStage: 'Annihilation', HideUnavailableStage: false,
    IsStageManually: false, UseOptionalStage: false, UseStoneAllowSave: false, HideSeries: false, StageResetMode: 'Current',
    UseWeeklySchedule: false, WeeklySchedule: allWeek(),
  }),
  Infrast: () => ({
    Mode: 'Normal', UsesOfDrones: 'Money', DormThreshold: 30, DormTrustEnabled: true, OriginiumShardAutoReplenishment: true, DormFilterNotStationed: true,
    ReceptionMessageBoard: true, ReceptionClueExchange: true, SendClue: true, ContinueTraining: false,
    FiammettaTarget1: '清流', FiammettaTarget2: '可露希尔', FiammettaTarget3: '但书', FiammettaRecoveryEnabled: false,
    UsePinusSylvestris: false, UsePerceptionInformation: false, UseWorldlyPlight: false, UseAbyssalHunter: false,
    UseWeeklySchedule: false, WeeklySchedule: allWeek(), CustomFileType: 'user_defined', Filename: '', PlanSelect: -1,
    RoomList: INFRAST_ROOMS.map(Room => ({Room, IsEnabled: true})),
  }),
  Roguelike: () => ({
    Theme: 'Phantom', Difficulty: INT_MAX, Mode: 'Exp', Squad: '', SquadCollectible: '', Roles: '', StartCount: 999999, StartingOpers: [],
    UseAdditionalStartingOpers: false, Investment: true, InvestCount: 999, InvestWithMoreScore: false, CollectibleStartAwards: ['HotWater', 'Hope', 'Idea'],
    CollectibleShopping: false, StartWithEliteTwo: false, StartWithEliteTwoOnly: false, ExpectedCollapsalParadigms: '',
    MonthlySquadAutoIterate: true, MonthlySquadCheckComms: true, DeepExplorationAutoIterate: true, FindPlaytimeTarget: 'Ling',
    BlackFlowCultivationTarget: 'Cat', BlackFlowEnding: 'Ending1', BlackFlowFastFlight: false, BlackFlowStartAnimal1: 'None', BlackFlowStartAnimal2: 'None',
    BlackFlowStartRewards: [], BlackFlowStartRunFastFlight: false, BlackFlowStartUtopia: false, BlackFlowStartRewardPriority: [...BLACKFLOW_REWARD_PRIORITY],
    UseSupportNonFriend: false, RefreshTraderWithDice: false, SamiFirstFloorFoldartal: false, SamiFirstFloorFoldartals: '',
    SamiNewSquad2StartingFoldartal: false, SamiNewSquad2StartingFoldartals: '', StopWhenDepositFull: false, StopAtFinalBoss: false,
    StopWhenLevelMax: false, StartWithSeed: false, Seed: '',
  }),
};

export const defaultGui = (type: GuiTaskType): Gui => DEFAULTS[type]();

/** Fields that Windows never writes to the config file (`[JsonIgnore]`). */
export const NEVER_SAVED: Partial<Record<GuiTaskType, string[]>> = {Recruit: ['UseExpedited']};

/**
 * Fill missing fields with Windows defaults and apply the `OnDeserialized` normalisations, so a
 * stored GUI config means exactly what Windows would load. Unknown fields are kept untouched.
 */
export function normalizeGui(type: GuiTaskType, gui: Gui | undefined): Gui {
  const g: Gui = {...defaultGui(type), ...(gui ?? {})};
  for (const key of NEVER_SAVED[type] ?? []) delete g[key];
  if (type === 'StartUp' && (g.AccountSwitchEnabled === null || gui?.AccountSwitchEnabled === undefined)) {
    // StartUpTask.OnDeserialized: a config without the field enables switching iff a name exists.
    g.AccountSwitchEnabled = gui?.AccountSwitchEnabled ?? !!g.AccountName;
  }
  if (type === 'Fight') {
    // FightTask.OnDeserialized
    if (g.UseStoneAllowSave !== true) g.UseStone = false;
    if (!Array.isArray(g.StagePlan)) g.StagePlan = [''];
    if (!g.UseOptionalStage && g.StagePlan.length !== 1) g.StagePlan = [...g.StagePlan, ''].slice(0, 1);
    g.WeeklySchedule = {...allWeek(), ...(g.WeeklySchedule ?? {})};
  }
  if (type === 'Infrast') {
    g.WeeklySchedule = {...allWeek(), ...(g.WeeklySchedule ?? {})};
    // InfrastTask.OnDeserialized: duplicate rooms are deduplicated (first wins).
    const seen = new Set<string>();
    g.RoomList = (Array.isArray(g.RoomList) ? g.RoomList : []).filter((r: any) => r && !seen.has(r.Room) && seen.add(r.Room));
    if (g.PlanSelect < -1) g.PlanSelect = -1;
  }
  if (type === 'Roguelike') {
    // RoguelikeTask.OnDeserialized: retired BlackFlowBabyAnimal mode → BlackFlowStartRun.
    if (g.Theme === 'BlackFlow' && g.Mode === 'BlackFlowBabyAnimal') {
      g.BlackFlowStartAnimal1 = ({Dog: 'Dog', Cerberus: 'Cerberus', FeatheredSerpent: 'FeatheredSerpent'} as Record<string, string>)[g.BlackFlowCultivationTarget] ?? 'Cat';
      g.BlackFlowStartAnimal2 = 'None';
      g.Mode = 'BlackFlowStartRun';
    }
    const known = new Set(BLACKFLOW_REWARD_PRIORITY);
    const priority = [...new Set<string>((Array.isArray(g.BlackFlowStartRewardPriority) ? g.BlackFlowStartRewardPriority : []).filter((r: string) => known.has(r)))];
    g.BlackFlowStartRewardPriority = [...priority, ...BLACKFLOW_REWARD_PRIORITY.filter(r => !priority.includes(r))];
  }
  if (type === 'Recruit') {
    g.Level3PreferTags = normalizeTags(g.Level3PreferTags);
    g.PreserveTagList = normalizeTags(g.PreserveTagList);
  }
  return g;
}

/** RecruitTagHelper.NormalizeTagList: drop blank, trim, distinct (ordinal). */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()))];
}
