/**
 * Schedule occurrence expansion for one Asia/Tokyo calendar day.
 *
 * The rules are the same ones `domain.nextDate` stores with (daily HH:mm, weekly `d H H:mm`,
 * five-field cron, interval minutes), mirrored here as pure functions so the builder does not
 * depend on Nest or on the mutable clock. Only occurrences at or after `schedule.createdAt` are
 * expanded: a schedule cannot have planned work before it existed, and the API must not invent
 * history that is not in the database.
 */
import { CronExpressionParser } from 'cron-parser';
import type { ScheduleRecord } from './contracts';
import { TIME_ZONE } from './jst';

/** Hard per-schedule cap for one day; `dataQuality.truncated` reports when it bites. */
export const MAX_OCCURRENCES_PER_SCHEDULE = 500;

const DAILY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKLY = /^([0-6](?:,[0-6])*) ([01]\d|2[0-3]):([0-5]\d)$/;
const INTERVAL = /^\d+$/;

export interface ExpansionResult {
  occurrences: Date[];
  truncated: boolean;
  invalid: boolean;
}

/** Translate a stored schedule rule into a five-field cron expression. */
export function cronFor(type: string, expression: string): string | null {
  if (type === 'daily') {
    const match = DAILY.exec(expression);
    return match ? `${Number(match[2])} ${Number(match[1])} * * *` : null;
  }
  if (type === 'weekly') {
    const match = WEEKLY.exec(expression);
    return match ? `${Number(match[3])} ${Number(match[2])} * * ${match[1]}` : null;
  }
  if (type === 'cron') {
    return expression.trim().split(/\s+/).length === 5 ? expression.trim() : null;
  }
  return null;
}

/** Interval minutes, or null when the stored expression is not a valid interval. */
export function intervalMinutes(expression: string): number | null {
  if (!INTERVAL.test(expression)) return null;
  const minutes = Number(expression);
  return minutes >= 1 && minutes <= 525600 ? minutes : null;
}

/**
 * Expand the occurrences of one schedule that fall inside the window, in ascending order.
 * Disabled schedules have no occurrences: they are not scheduled to fire.
 */
export function expandOccurrences(
  schedule: ScheduleRecord,
  window: { start: Date; end: Date },
  cap: number = MAX_OCCURRENCES_PER_SCHEDULE,
): ExpansionResult {
  if (!schedule.enabled) return { occurrences: [], truncated: false, invalid: false };
  const limit = Math.max(1, Math.min(cap, MAX_OCCURRENCES_PER_SCHEDULE));
  const notBefore = Math.max(window.start.getTime(), schedule.createdAt.getTime());
  const end = window.end.getTime();

  if (schedule.type === 'interval') {
    const minutes = intervalMinutes(schedule.expression);
    if (!minutes) return { occurrences: [], truncated: false, invalid: true };
    const step = minutes * 60000;
    const anchor = schedule.nextAt.getTime();
    // Every occurrence lives on the lattice anchor + k*step; `nextAt` is one member of it.
    const offset = ((anchor - notBefore) % step + step) % step;
    const occurrences: Date[] = [];
    let at = notBefore + offset;
    while (at < end) {
      if (occurrences.length >= limit) return { occurrences, truncated: true, invalid: false };
      occurrences.push(new Date(at));
      at += step;
    }
    return { occurrences, truncated: false, invalid: false };
  }

  const rule = cronFor(schedule.type, schedule.expression);
  if (!rule) return { occurrences: [], truncated: false, invalid: true };
  const occurrences: Date[] = [];
  try {
    // `currentDate: notBefore - 1ms` makes an occurrence exactly at `notBefore` visible.
    const iterator = CronExpressionParser.parse(rule, {
      currentDate: new Date(notBefore - 1),
      endDate: new Date(end),
      tz: TIME_ZONE,
      strict: false,
    });
    let guard = 0;
    while (iterator.hasNext()) {
      const date = iterator.next().toDate();
      if (date.getTime() >= end) break;
      if (date.getTime() < notBefore) continue;
      if (occurrences.length >= limit) return { occurrences, truncated: true, invalid: false };
      occurrences.push(date);
      if (++guard > limit + 1) break;
    }
  } catch {
    return { occurrences: [], truncated: false, invalid: true };
  }
  return { occurrences, truncated: false, invalid: false };
}

/** The next occurrence strictly after `after`, or null when the rule is disabled/invalid. */
export function nextOccurrence(schedule: ScheduleRecord, after: Date): Date | null {
  if (!schedule.enabled) return null;
  const afterMs = after.getTime();
  if (schedule.type === 'interval') {
    const minutes = intervalMinutes(schedule.expression);
    if (!minutes) return null;
    const step = minutes * 60000;
    const anchor = schedule.nextAt.getTime();
    if (anchor > afterMs) return new Date(anchor);
    const next = anchor + (Math.floor((afterMs - anchor) / step) + 1) * step;
    return new Date(next);
  }
  const rule = cronFor(schedule.type, schedule.expression);
  if (!rule) return null;
  try {
    return CronExpressionParser.parse(rule, {
      currentDate: new Date(afterMs),
      tz: TIME_ZONE,
      strict: false,
    }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * A schedule's *next* firing for display. The row's stored `nextAt` is authoritative while it is
 * still in the future; a stale stored value (for example the queue has not advanced yet) is
 * replaced with the next value the rule itself implies. This reads the rule but never the log.
 */
export function nextRunFor(schedule: ScheduleRecord, now: Date): Date | null {
  if (!schedule.enabled) return null;
  if (schedule.nextAt.getTime() > now.getTime()) return schedule.nextAt;
  return nextOccurrence(schedule, now);
}

