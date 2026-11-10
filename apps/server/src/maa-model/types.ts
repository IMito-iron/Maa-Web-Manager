// Windows MAA v6.21.4 task model shared by the Manager server (authoritative compile at dispatch)
// and the web editor (preview / neutral compile on save). Pure TypeScript: no Node or DOM APIs,
// so both apps can import it. Every rule cites its upstream source in the implementing module.

/** maa-cli / Core client_type strings (maa-cli `ClientType`, Windows `ToCustomString`). */
export type ClientType = 'Official' | 'Bilibili' | 'YoStarEN' | 'YoStarJP' | 'YoStarKR' | 'txwy';
export const CLIENT_TYPES: ClientType[] = ['Official', 'Bilibili', 'YoStarEN', 'YoStarJP', 'YoStarKR', 'txwy'];

/**
 * Per-preset settings, the Web equivalent of `Configurations.<cfg>.Gui.*` in gui.new.json.
 * The client type itself stays the preset's top-level `client_type` (maa-cli reads it).
 */
export interface PresetSettings {
  /** `Gui.RuntimeSettings.StartGame` (default true, RuntimeSettings.cs). */
  StartGame: boolean;
  /** `Gui.ThirdParty.*`. */
  ReportToPenguin: boolean;
  PenguinId: string;
  ReportToYituliu: boolean;
}

export const DEFAULT_SETTINGS: PresetSettings = {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false};

/** Task types that have a Windows GUI model here. Everything else stays raw maa-cli params. */
export type GuiTaskType = 'StartUp' | 'Recruit' | 'Infrast' | 'Fight' | 'Mall' | 'Award' | 'Roguelike' | 'Custom' | 'SwitchTheme';
export const GUI_TASK_TYPES: GuiTaskType[] = ['StartUp', 'Recruit', 'Infrast', 'Fight', 'Mall', 'Award', 'Roguelike', 'Custom', 'SwitchTheme'];
export const isGuiTaskType = (type: unknown): type is GuiTaskType => GUI_TASK_TYPES.includes(type as GuiTaskType);

/** A task's GUI configuration: field names are the Windows config field names (gui.new.json). */
export type Gui = Record<string, any>;

export type WeekDay = 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';
export const WEEK_DAYS: WeekDay[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One plan of a custom infrast JSON (`plans[].period` is a list of ["HH:mm","HH:mm"]). */
export interface InfrastPlan { index: number; period: [string, string][]; }
export type InfrastPlanRead = {ok: true; plans: InfrastPlan[]} | {ok: false; missing: boolean};

/** Mall once-a-day state; dates are game-day strings `YYYY-MM-DD` (Windows `*LastTime`). */
export interface MallHistory { visitFriends?: string; creditFight?: string; }

/** "This run only" values of the tri-state check boxes (Windows `null`), supplied per manual run. */
export interface RunOverrides {
  UseMedicine?: boolean; UseStone?: boolean; EnableTimesLimit?: boolean; EnableTargetDrop?: boolean; UseExpedited?: boolean;
}

export interface StageAvailability {
  /** Windows `StageManager.IsStageOpen(stage, dayOfWeek)` at instant `now`. */
  isOpen(stage: string, day: number, now: Date): boolean;
  /** Whether a currently open side-story activity expires within 2 days (Fight 48h medicine rule). */
  activityExpiresWithin2Days(now: Date): boolean;
  /** True when real activity data was loaded (otherwise only the permanent table is known). */
  readonly hasActivityData: boolean;
  /** Stage values currently known (permanent + activity); used for StageResetMode. */
  knows(stage: string): boolean;
}

/** Runtime inputs to compilation (dependency inversion: adapters live in the server). */
export interface RuntimeContext {
  now: Date;
  /**
   * Neutral compile: time-, history- and file-independent. Used on save to write a `params`
   * snapshot that an older Manager or a direct `maa run` can still execute.
   */
  neutral: boolean;
  stages: StageAvailability;
  /** IANA zone for "local time" rules (Infrast plan periods); Windows uses the PC clock. */
  localTimeZone: string;
  infrastPlans?(filename: string): InfrastPlanRead;
  /** Absolute path for a built-in custom infrast file (resource/custom_infrast/<file>). */
  builtinInfrastPath?(file: string): string;
  mallHistory?(key: string): MallHistory;
  /** Operator alias → official name (Windows DataHelper.GetCharacterByNameOrAlias). */
  operatorName?(nameOrAlias: string): string | undefined;
  overrides?(taskIndex: number): RunOverrides | undefined;
}

export type TaskCompile =
  | {kind: 'append'; type: string; params: Record<string, unknown>; notes: string[]}
  | {kind: 'skip'; reason: string; notes: string[]}
  | {kind: 'error'; reason: string; notes: string[]};

export const INT_MAX = 2147483647;
