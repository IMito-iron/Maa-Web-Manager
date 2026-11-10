// The Manager's wall-clock time zone (schedules, Infrast plan periods, times shown in the console).
// One environment variable, validated once; an invalid value fails startup instead of silently
// firing schedules at the wrong hour.
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

let cached: string | null = null;

export function parseTimeZone(value: string | undefined): string {
  const zone = (value ?? '').trim() || DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat('en-US', {timeZone: zone}); }
  catch { throw new Error(`MANAGER_TIME_ZONE must be an IANA time zone such as Asia/Shanghai, got "${zone}"`); }
  return zone;
}

/** MANAGER_TIME_ZONE, or the default when unset. */
export function scheduleTimeZone(): string {
  if (cached === null) cached = parseTimeZone(process.env.MANAGER_TIME_ZONE);
  return cached;
}
