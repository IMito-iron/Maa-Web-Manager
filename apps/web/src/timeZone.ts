// The scheduler's time zone is a server setting (MANAGER_TIME_ZONE, reported as `timezone` by
// /api/status). Every date the console shows uses it, so a browser in another zone still sees the
// times the schedules actually fire at. Until the first status arrives the documented default is used.
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
let current = DEFAULT_TIME_ZONE;

function valid(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', {timeZone: zone}); return true; } catch { return false; }
}

/** Adopt the zone reported by the server; unknown or malformed values are ignored. */
export function setServerTimeZone(zone: unknown): void {
  if (typeof zone === 'string' && zone && valid(zone)) current = zone;
}

export function serverTimeZone(): string {
  return current;
}
