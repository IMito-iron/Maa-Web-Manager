// Stage availability, ported from MaaWpfGui v6.21.4 `Services/StageManager.cs` and `Models/StageInfo.cs`.
// The permanent table is hard-coded in the Windows GUI itself (AddPermanentStages); activity stages
// come from the MAA API file `gui/StageActivityV2.json`, which the server adapter supplies when present.
import type {ClientType, StageAvailability} from './types';
import {clientInfo} from './clients';

interface Window_ { start: number; expire: number; }
interface StageInfo {
  value?: string;                // activity stages: the stage code (they are keyed by Display)
  days?: number[];               // OpenDaysOfWeek (0 = Sunday); empty/undefined = every day
  activity?: Window_ & {resource: boolean};
}
const MIN = -8.64e15; // DateTime.MinValue stand-in

const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;
const RESOURCE: Record<string, number[]> = {
  'CE-6': [TUE, THU, SAT, SUN], 'AP-5': [MON, THU, SAT, SUN], 'CA-5': [TUE, WED, FRI, SUN], 'LS-6': [], 'SK-5': [MON, WED, FRI, SAT],
  'PR-A-1': [MON, THU, FRI, SUN], 'PR-A-2': [MON, THU, FRI, SUN], 'PR-B-1': [MON, TUE, FRI, SAT], 'PR-B-2': [MON, TUE, FRI, SAT],
  'PR-C-1': [WED, THU, SAT, SUN], 'PR-C-2': [WED, THU, SAT, SUN], 'PR-D-1': [TUE, WED, SAT, SUN], 'PR-D-2': [TUE, WED, SAT, SUN],
};
/** Permanent stages without day limits or activity (always open). */
const ALWAYS = ['', '1-7', 'R8-11', '12-17-HARD', 'Annihilation', 'OF-1', 'OF-F3'];
/** Values shown in the Windows stage dropdown (non-hidden permanent stages), in Windows order. */
export const PERMANENT_STAGE_OPTIONS = ['', '1-7', 'R8-11', '12-17-HARD', 'CE-6', 'AP-5', 'CA-5', 'LS-6', 'SK-5', 'Annihilation',
  'PR-A-1', 'PR-A-2', 'PR-B-1', 'PR-B-2', 'PR-C-1', 'PR-C-2', 'PR-D-1', 'PR-D-2'];
export const RESOURCE_STAGE_DAYS = RESOURCE;

/** StageManager.ParseDateTime: "yyyy/MM/dd HH:mm:ss" in `TimeZone` hours → UTC ms. */
function parseTime(token: any, key: string): number {
  const m = typeof token?.[key] === 'string' && /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(token[key]);
  if (!m) return NaN;
  const tz = Number.isFinite(Number(token?.TimeZone)) ? Number(token.TimeZone) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - tz * 3600000;
}
const versionOk = (value: unknown) => typeof value === 'string' && /^v?\d+(\.\d+){0,3}([-+].*)?$/.test(value.trim());
const beingOpen = (w: Window_, now: number) => !(now <= w.start) && !(now >= w.expire);

export class StageCatalog implements StageAvailability {
  private stages = new Map<string, StageInfo>();
  private activities: Window_[] = [];
  readonly hasActivityData: boolean;

  /** @param activityJson parsed StageActivityV2.json, or null when unavailable. */
  constructor(client: ClientType, activityJson: unknown = null) {
    const data = (activityJson as any)?.[clientInfo(client).activityKey];
    this.hasActivityData = !!data && typeof data === 'object';
    const rc = data?.resourceCollection;
    const resource = {resource: true, start: rc ? parseTime(rc, 'UtcStartTime') : MIN, expire: rc ? parseTime(rc, 'UtcExpireTime') : MIN};
    if (!Number.isFinite(resource.start) || !Number.isFinite(resource.expire)) { resource.start = MIN; resource.expire = MIN; }
    // Activity stages first: Windows TryAdd()s them before the permanent table, keyed by Display.
    const side = data?.sideStoryStage;
    if (side && typeof side === 'object' && !Array.isArray(side)) {
      for (const group of Object.values<any>(side)) {
        const stages = group?.Stages ?? group?.stages;
        if (!Array.isArray(stages)) continue;
        const groupActivity = group?.Activity ?? group?.activity;
        const groupMin = group?.MinimumRequired ?? group?.minimumRequired;
        if (groupActivity) {
          const start = parseTime(groupActivity, 'UtcStartTime'), expire = parseTime(groupActivity, 'UtcExpireTime');
          this.activities.push({start: Number.isFinite(start) ? start : MIN, expire: Number.isFinite(expire) ? expire : MIN});
        }
        for (const stage of stages) {
          if (!versionOk(stage?.MinimumRequired ?? groupMin)) continue;
          const token = stage?.Activity ?? groupActivity;
          const start = token ? parseTime(token, 'UtcStartTime') : MIN, expire = token ? parseTime(token, 'UtcExpireTime') : MIN;
          const display = typeof stage?.Display === 'string' ? stage.Display : '';
          const value = typeof stage?.Value === 'string' ? stage.Value : '';
          if (!this.stages.has(display)) this.stages.set(display, {value, activity: {resource: false, start: Number.isFinite(start) ? start : MIN, expire: Number.isFinite(expire) ? expire : MIN}});
        }
      }
    }
    for (const value of ALWAYS) if (!this.stages.has(value)) this.stages.set(value, {});
    for (const [value, days] of Object.entries(RESOURCE)) if (!this.stages.has(value)) this.stages.set(value, {days, activity: resource});
  }

  knows(stage: string) { return this.stages.has(stage); }

  /**
   * The Windows stage dropdown (StageManager.GetStageList): non-hidden stages that are open or will
   * open — "" first, then activity stages in file order, then the permanent table.
   */
  stageList(now: Date, day: number): {value: string; display: string; open: boolean; activity: boolean}[] {
    const t = now.getTime();
    const activity = [...this.stages.entries()]
      .filter(([, info]) => info.activity && !info.activity.resource && info.value !== undefined && t < info.activity.expire)
      .map(([display, info]) => ({value: info.value!, display, open: this.isOpen(display, day, now), activity: true}));
    const permanent = PERMANENT_STAGE_OPTIONS.filter(v => v !== '').map(value => ({value, display: value, open: this.isOpen(value, day, now), activity: false}));
    return [{value: '', display: '', open: true, activity: false}, ...activity, ...permanent];
  }

  /** StageManager.GetStageInfo + StageInfo.IsStageOpen. */
  isOpen(stage: string, day: number, now: Date): boolean {
    let info = this.stages.get(stage);
    if (!info) {
      // Unknown "XX-n" codes are treated as expired activity stages; anything else as permanent.
      if (stage && /^[A-Za-z]{2}-\d{1,2}$/.test(stage)) return false;
      return true;
    }
    if (info.activity) {
      if (beingOpen(info.activity, now.getTime())) return true;
      if (!info.activity.resource) return false;
    }
    return info.days?.length ? info.days.includes(day) : true;
  }

  /** FightTaskUserControlModel.BuildAsstFightTask: first open activity, `(expire - now).Days < 2`. */
  activityExpiresWithin2Days(now: Date): boolean {
    const t = now.getTime();
    const open = this.activities.find(a => a.start <= t && t <= a.expire);
    return !!open && (open.expire - t) < 2 * 86400000;
  }
}
