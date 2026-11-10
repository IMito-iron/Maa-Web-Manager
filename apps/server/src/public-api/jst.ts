/**
 * Asia/Tokyo calendar arithmetic, pure and explicit.
 *
 * Japan Standard Time is a fixed UTC+09:00 with no daylight saving, so a day window is always
 * exactly 24 hours and no tz database is needed. Every timestamp this module emits carries the
 * literal `+09:00` offset so clients never have to guess the zone.
 */
import { dateOutOfRange, invalidDate } from './errors';

export const TIME_ZONE = 'Asia/Tokyo';
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayWindow {
  /** Inclusive start: `date` 00:00:00+09:00. */
  start: Date;
  /** Exclusive end: next calendar day 00:00:00+09:00. */
  end: Date;
  dateKey: string;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (value: number): string => String(value).padStart(2, '0');
const pad3 = (value: number): string => String(value).padStart(3, '0');

interface JstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** Break an instant into Asia/Tokyo wall-clock parts without touching the host time zone. */
export function jstParts(date: Date): JstParts {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

/** `YYYY-MM-DD` for the Asia/Tokyo calendar day containing the instant. */
export function jstDateKey(date: Date): string {
  const parts = jstParts(date);
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** `YYYY-MM-DD` for the 0-based weekday of an instant in Asia/Tokyo (0 = Sunday). */
export function jstWeekday(date: Date): number {
  return new Date(date.getTime() + JST_OFFSET_MS).getUTCDay();
}

/**
 * Parse `YYYY-MM-DD` as an Asia/Tokyo calendar day. Returns null for bad syntax or impossible
 * calendar dates (for example 2026-02-30); never rolls a date over silently.
 */
export function parseDateKey(key: string): Date | null {
  const match = DATE_KEY.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const start = new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
  // Round-trip rejects 2026-02-30 and friends without a separate day-count table.
  return jstDateKey(start) === key ? start : null;
}

export function dayWindow(dateKey: string): DayWindow {
  const start = parseDateKey(dateKey);
  if (!start) throw invalidDate();
  return { start, end: new Date(start.getTime() + DAY_MS), dateKey };
}

/** `value + days` on the Asia/Tokyo calendar, keeping the YYYY-MM-DD form. */
export function addDaysKey(dateKey: string, days: number): string {
  const start = parseDateKey(dateKey);
  if (!start) throw invalidDate();
  return jstDateKey(new Date(start.getTime() + days * DAY_MS));
}

/** ISO-8601 with an explicit +09:00 offset; null stays null. */
export function formatJst(date: Date | null | undefined): string | null {
  if (!date) return null;
  if (!Number.isFinite(date.getTime())) return null;
  const parts = jstParts(date);
  return (
    `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}+09:00`
  );
}

/**
 * Resolve the requested `date` to a safe calendar day.
 *
 * - omitted/null/undefined -> today in Asia/Tokyo
 * - bad syntax or impossible date -> `invalid_date` (400)
 * - later than today in Asia/Tokyo -> `date_out_of_range` (400), never clamped
 * - earlier than `today - maxLookbackDays` -> `date_out_of_range` (400), never clamped
 */
export function resolveDateKey(raw: unknown, now: Date, maxLookbackDays: number): string {
  const today = jstDateKey(now);
  if (raw === undefined || raw === null) return today;
  if (typeof raw !== 'string') throw invalidDate();
  const start = parseDateKey(raw);
  if (!start) throw invalidDate();
  const key = jstDateKey(start);
  if (key > today) throw dateOutOfRange();
  const earliest = addDaysKey(today, -Math.max(0, Math.floor(maxLookbackDays)));
  if (key < earliest) throw dateOutOfRange();
  return key;
}
