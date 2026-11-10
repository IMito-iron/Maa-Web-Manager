import type {ClientType} from './types';

interface ClientInfo {
  /** SettingsViewModel._serverMapping */
  server: string;
  /** DateTimeExtension._clientTypeTimezone (hours) */
  tz: number;
  /** MallTaskUserControlModel._blackCharacterListMapping */
  blacklist: string[];
  /** StartUpTaskUserControlModel: account switching only for Official/Bilibili/Txwy/KR */
  accountSwitch: boolean;
  /** StageManager.GetClientType(): Bilibili shares the Official activity data */
  activityKey: string;
}

const CN_BLACK = ['讯使', '嘉维尔', '坚雷'];
const CLIENTS: Record<ClientType, ClientInfo> = {
  Official: {server: 'CN', tz: 8, blacklist: CN_BLACK, accountSwitch: true, activityKey: 'Official'},
  Bilibili: {server: 'CN', tz: 8, blacklist: CN_BLACK, accountSwitch: true, activityKey: 'Official'},
  YoStarEN: {server: 'US', tz: -7, blacklist: ['Courier', 'Gavial', 'Dur-nar'], accountSwitch: false, activityKey: 'YoStarEN'},
  YoStarJP: {server: 'JP', tz: 9, blacklist: ['クーリエ', 'ガヴィル', 'ジュナー'], accountSwitch: false, activityKey: 'YoStarJP'},
  YoStarKR: {server: 'KR', tz: 9, blacklist: ['쿠리어', '가비알', '듀나'], accountSwitch: true, activityKey: 'YoStarKR'},
  txwy: {server: 'ZH_TW', tz: 8, blacklist: ['訊使', '嘉維爾', '堅雷'], accountSwitch: true, activityKey: 'txwy'},
};

/** maa-cli defaults a missing/unknown preset client_type to Official (TaskConfigTemplate::init). */
export function clientOf(value: unknown): ClientType {
  return typeof value === 'string' && value in CLIENTS ? value as ClientType : 'Official';
}
export const clientInfo = (client: ClientType): ClientInfo => CLIENTS[client];

/** Game ("鹰历") day starts at 04:00 server time: DateTimeExtension.ToYjDateTime. */
const YJ_DAY_START_HOUR = 4;
const shifted = (now: Date, client: ClientType) => new Date(now.getTime() + (CLIENTS[client].tz - YJ_DAY_START_HOUR) * 3600000);

/** Day of week (0 = Sunday) of the game day; TaskQueueViewModel.CurDayOfWeek. */
export const gameDayOfWeek = (now: Date, client: ClientType) => shifted(now, client).getUTCDay();

/** Game date `YYYY-MM-DD`; MallTask once-a-day comparisons (ToYjDate). */
export const gameDate = (now: Date, client: ClientType) => shifted(now, client).toISOString().slice(0, 10);

/** Hour:minute of `now` in an IANA zone, as minutes since midnight (Infrast plan periods). */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
