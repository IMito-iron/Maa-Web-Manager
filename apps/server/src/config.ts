import path from 'node:path';
import {parseAccountIdentityPolicy} from './account-safety';
import {parseApiBases} from './stage-activity';
import {scheduleTimeZone} from './time-zone';
export const cfg = {
  data: process.env.DATA_DIR || '/data',
  tasks: path.join(process.env.MAA_CONFIG_DIR || '/config', 'tasks'),
  maa: process.env.MAA_BIN || '/opt/maa/bin/maa',
  adb: process.env.ADB_BIN || '/usr/bin/adb',
  deviceConfig: process.env.DEVICE_CONFIG || '/device-config/devices.json',
  origin: process.env.PUBLIC_ORIGIN || '',
  display: process.env.DISPLAY_URL || 'http://device:6080/vnc.html',
  web: process.env.WEB_DIR || '/app/apps/web/dist',
  logLimit: Number(process.env.LOG_LIMIT_BYTES || 10485760),
  retention: Number(process.env.LOG_RETENTION_DAYS || 30),
  // Account presets when no identity probe exists: strict block (default) or an explicitly
  // labelled compatibility mode that continues after a completed StartUp and records the risk.
  accountPolicy: parseAccountIdentityPolicy(process.env.ACCOUNT_IDENTITY_POLICY),
  // Where the remembered sanity-drain stage lives, and what to use before one is learned.
  sanityState: path.join(process.env.DATA_DIR || '/data', 'state', 'sanity-stage.json'),
  sanityFallback: process.env.SANITY_FALLBACK_STAGE || 'LS-6',
  // Windows-parity compile inputs (maa-model runtime ports).
  maaConfig: process.env.MAA_CONFIG_DIR || '/config',
  maaData: process.env.MAA_DATA_DIR || '/opt/maa/share',
  // MAA API `gui/StageActivityV2.json`, placed here by an operator or a future fetcher; optional.
  stageActivity: process.env.MAA_STAGE_ACTIVITY_FILE || path.join(process.env.DATA_DIR || '/data', 'cache', 'StageActivityV2.json'),
  // MAA API bases for StageActivityV2.json (Windows MaaUrls.MaaApi / MaaApi2); "off" disables fetching.
  maaApiBases: parseApiBases(process.env.MAA_API_URLS),
  // Explicit battle_data.json (operator names); otherwise the maa-cli resource directories are searched.
  battleData: process.env.MAA_BATTLE_DATA_FILE || '',
  mallHistory: path.join(process.env.DATA_DIR || '/data', 'state', 'mall-history.json'),
  // Wall-clock zone for schedules, Infrast plan periods and every time the console shows.
  timeZone: scheduleTimeZone(),
};
