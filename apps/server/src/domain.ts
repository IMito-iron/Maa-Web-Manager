import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { scheduleTimeZone } from './time-zone';
export function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new BadRequestException('Invalid task name');
  return value;
}
export function parseTask(raw: unknown): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) throw new BadRequestException('JSON must be text, at most 1 MiB');
  let data; try { data = JSON.parse(raw); } catch { throw new BadRequestException('Invalid JSON'); }
  if (!data || !Array.isArray(data.tasks) || !data.tasks.length || data.tasks.some((t: any) => !t || typeof t.type !== 'string')) throw new BadRequestException('Expected a non-empty tasks array with task type strings');
  for (const task of data.tasks) {
    if (task.type === 'Fight' && task.params && Object.hasOwn(task.params, 'medicine_expire_days')) {
      const days = task.params.medicine_expire_days;
      if (days && typeof days === 'object' && !Array.isArray(days)) continue; // CLI resolves opaque value templates.
      if (!Number.isInteger(days) || days < 0 || days > 2147483647) throw new BadRequestException('medicine_expire_days must be integer days from 0 to 2147483647');
    }
  }
  return raw;
}
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Next fire time of a schedule; wall-clock rules (daily, weekly, cron) are evaluated in `tz` (MANAGER_TIME_ZONE). */
export function nextDate(type: string, expression: string, now = new Date(), tz = scheduleTimeZone()): Date {
  if (type === 'interval') {
    if (!/^\d+$/.test(expression) || +expression < 1 || +expression > 525600) throw new BadRequestException('Interval must be 1–525600 minutes');
    return new Date(now.getTime() + Number(expression) * 60000);
  }
  if (!['daily', 'weekly', 'cron'].includes(type)) throw new BadRequestException('Unknown schedule type');
  let rule = expression;
  if (type === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(expression)) throw new BadRequestException('Use HH:mm');
    const [h,m] = expression.split(':'); rule = `${+m} ${+h} * * *`;
  }
  if (type === 'weekly') {
    if (!/^[0-6](,[0-6])* ([01]\d|2[0-3]):[0-5]\d$/.test(expression)) throw new BadRequestException('Use weekdays 0–6 then HH:mm, e.g. 0,6 02:00');
    const [days,time] = expression.split(' '); const [h,m] = time.split(':'); rule = `${+m} ${+h} * * ${days}`;
  }
  if (rule.trim().split(/\s+/).length !== 5) throw new BadRequestException('Cron requires five fields');
  try { return CronExpressionParser.parse(rule, { currentDate: now, tz }).next().toDate(); }
  catch { throw new BadRequestException('Invalid cron expression'); }
}
