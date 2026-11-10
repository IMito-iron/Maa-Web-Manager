// Structured editing of schedule rules.
//
// The wire format is fixed by the server (see domain.nextDate): `interval` is a whole number
// of minutes, `daily` is HH:mm, `weekly` is "<days> HH:mm" with 0 = Sunday, and `cron` is
// five fields. These helpers only ever produce that format, and they tolerate junk when
// loading an existing rule so the editor can never lose or corrupt what is stored.
//
// Every human-readable label is produced through the caller's `t`, defaulting to the identity so
// the module stays pure and usable without a translation context.
export type ScheduleType = 'interval' | 'daily' | 'weekly' | 'cron';

export interface ScheduleFields {
  minutes: number;
  time: string;
  weekdays: number[];
  cron: string[];
}

export type Translate = (text: string, params?: Record<string, string | number>) => string;
const identity: Translate = text => text;

export const weekdayLabels = (t: Translate = identity) =>
  ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map(day => t(day));

export const scheduleTypes = (t: Translate = identity): {value: ScheduleType; label: string}[] => [
  {value: 'interval', label: t('每若干分钟')},
  {value: 'daily', label: t('每天')},
  {value: 'weekly', label: t('每周')},
  {value: 'cron', label: t('Cron 表达式（高级）')},
];

export const cronFields = (t: Translate = identity) => [
  {label: t('分钟'), hint: '0-59'},
  {label: t('小时'), hint: '0-23'},
  {label: t('日'), hint: '1-31'},
  {label: t('月'), hint: '1-12'},
  {label: t('星期'), hint: t('0-6，0=周日')},
];

const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validDay = (value: number) => Number.isInteger(value) && value >= 0 && value <= 6;

export const emptyFields = (): ScheduleFields => ({
  minutes: 360, time: '06:00', weekdays: [1], cron: ['0', '6', '*', '*', '*'],
});

/** Fields for an existing rule, so opening the editor never rewrites what was stored. */
export function splitExpression(type: string, expression: string): ScheduleFields {
  const fields = emptyFields();
  const text = String(expression ?? '').trim();
  if (type === 'interval') {
    const minutes = Number(text);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 525600) fields.minutes = minutes;
  } else if (type === 'daily') {
    if (validTime(text)) fields.time = text;
  } else if (type === 'weekly') {
    // Invalid legacy weeks stay invalid; never infer Monday or coerce empty tokens to Sunday.
    const match = /^([0-6](?:,[0-6])*) ([01]\d|2[0-3]):[0-5]\d$/.exec(text);
    fields.weekdays = match ? [...new Set(match[1].split(',').map(Number))].sort((a, b) => a - b) : [];
    fields.time = match ? text.split(' ')[1] : '';
  } else if (type === 'cron') {
    const parts = text.split(/\s+/);
    if (parts.length === 5) fields.cron = parts;
  }
  return fields;
}

export function composeExpression(type: string, fields: ScheduleFields): string {
  if (type === 'interval') return String(Math.min(525600, Math.max(1, Math.trunc(Number(fields.minutes) || 1))));
  if (type === 'daily') return validTime(fields.time) ? fields.time : '06:00';
  if (type === 'weekly') {
    if (!fields.weekdays.length || fields.weekdays.some(day => !validDay(day)) || !validTime(fields.time)) return '';
    const days = [...new Set(fields.weekdays)].sort((a, b) => a - b);
    return `${days.join(',')} ${fields.time}`;
  }
  if (type === 'cron') {
    return Array.from({length: 5}, (_, index) => String(fields.cron[index] ?? '').trim() || '*').join(' ');
  }
  return '';
}

/** Human-readable rule for the list, so raw expressions are not the primary presentation. */
export function describeSchedule(type: string, expression: string, t: Translate = identity): string {
  const text = String(expression ?? '').trim();
  if (type === 'interval') return /^\d+$/.test(text) ? t('每 {text} 分钟', {text}) : t('每 {text}', {text});
  if (type === 'daily') return t('每天 {text}', {text});
  if (type === 'weekly') {
    const [days, time] = text.split(/\s+/);
    const labels = (days ?? '').split(',').map(Number).filter(validDay).map(day => weekdayLabels(t)[day]);
    return labels.length ? t('每{labels} {time}', {labels: labels.join('、'), time: time ?? ''}).trim() : text;
  }
  if (type === 'cron') return `Cron ${text}`;
  return text;
}

/** Which parts of a rule the editor must show for this type. */
export const fieldsFor = (type: string) => ({
  minutes: type === 'interval', time: type === 'daily' || type === 'weekly',
  weekdays: type === 'weekly', cron: type === 'cron',
});
