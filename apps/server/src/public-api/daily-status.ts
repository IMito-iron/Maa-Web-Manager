/**
 * Pure daily-status builder.
 *
 * Input is plain rows (from one consistent storage read) plus read-only engine state; output is the
 * documented JSON contract. No Prisma, Nest, Express, file or network access happens here, which is
 * what makes every rule below unit-testable with an injected clock.
 *
 * Rules that exist specifically so the bot cannot be told something that is not true:
 * - a future occurrence is never `executed`/`completed` (only `pending`);
 * - `status = success` is downgraded to `success_unconfirmed` when the stored reason says the work
 *   was not confirmed (the annihilation "completed but not confirmed" case is one of these);
 * - runs are assigned to a day by their effective start (startedAt ?? createdAt), and runs that
 *   started before the window are reported only as `carriedIn` — never folded into the day counts;
 * - a missed occurrence is marked `queue_paused` only when the queue is paused at query time;
 * - disabled schedules produce no planned occurrences at all;
 * - presets/schedules/runs are never mixed across presets (all grouping is by exact `task`).
 */
import { analyzePresetAccount } from '../account-safety';
import type { AccountIdentityPolicy } from '../account-safety';
import type {
  BuildOptions,
  CompletionConfidence,
  EngineState,
  PresetRecord,
  RunOutcome,
  RunRecord,
  RunSource,
  ScheduleRecord,
} from './contracts';
import { dayWindow, formatJst, resolveDateKey, type DayWindow } from './jst';
import { expandOccurrences, nextRunFor } from './occurrences';

export const MAX_PLAN_OCCURRENCES_PER_PRESET = 1000;

/**
 * Reasons that mean "the run reported success but the work was not confirmed". The first two
 * Chinese alternatives cover the annihilation drain case: MAA finishes the chain without spending
 * the sanity, so a zero exit code must not be presented as a confirmed completion. The account
 * identity reason codes are included because the switching coordinator reports an unverified
 * identity through `Run.reason` as well.
 */
const UNCONFIRMED_REASON =
  /未确认|unconfirmed|理智未耗尽|未用尽|TaskChainError|SubTaskError|ACCOUNT_IDENTITY/i;

const SENSITIVE_WORDS = /account_name|accountName|snapshot|DATABASE_URL|password|token/gi;
const SENSITIVE_VALUES = /(?:account_name|accountName|snapshot|DATABASE_URL|password|token)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi;
const PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`)]*/g;

export type IdentityConfirmation = 'unavailable' | 'confirmed' | 'unconfirmed';

export interface AccountFlags {
  accountSwitchConfigured: boolean;
  identityConfirmation: IdentityConfirmation;
}

export interface RunItem {
  id: string;
  task: string;
  source: RunSource;
  /** Raw database status, kept for diagnosis; use `outcome` for semantics. */
  status: string;
  outcome: RunOutcome;
  completionConfidence: CompletionConfidence;
  subtasksConfirmed: boolean | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  durationSeconds: number | null;
  /** Sanitised: no paths, no account fields, bounded length. */
  reason: string | null;
  crossMidnight: boolean;
  occurrence: string | null;
}

export interface PlanOccurrence {
  at: string;
  scheduleId: string;
  scheduleName: string;
  type: string;
  expression: string;
  state: 'pending' | 'executed' | 'missed';
  missedReason: 'queue_paused' | 'no_run_recorded' | null;
  runId: string | null;
  runOutcome: RunOutcome | null;
  additionalRuns: number;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  type: string;
  expression: string;
  enabled: boolean;
  /** Stored value from the database (may already be the next one). */
  nextAt: string | null;
  /** Next firing implied by the rule when the stored value is in the past. */
  nextScheduledAt: string | null;
}

export interface OutcomeCounts {
  count: number;
  byOutcome: Record<RunOutcome, number>;
}

export interface PresetDailyStatus {
  task: string;
  displayName: string;
  unreadable: boolean;
  accountSwitchConfigured: boolean;
  identityConfirmation: IdentityConfirmation;
  plan: PlanOccurrence[];
  schedules: ScheduleSummary[];
  runs: Omit<OutcomeCounts, 'count'> & {
    total: number;
    items: RunItem[];
    bySource: Record<RunSource, number>;
    manual: OutcomeCounts;
    scheduled: OutcomeCounts;
    sanityRetry: OutcomeCounts;
    other: OutcomeCounts;
  };
  carriedIn: { count: number; items: RunItem[] };
  current: {
    queuePaused: boolean;
    queueBlocked: boolean;
    running: boolean;
    runId: string | null;
    status: string | null;
    since: string | null;
    queuedCount: number;
  };
  nextScheduledAt: string | null;
}

export interface DailyStatusResponse {
  generatedAt: string;
  timeZone: 'Asia/Tokyo';
  /** Explicit account identity policy in force. Account presets are never claimed as verified. */
  accountPolicy: AccountIdentityPolicy;
  date: string;
  dayWindow: { start: string; end: string };
  /** When the consistent schedule+run read batch completed. */
  databaseReadAt: string;
  freshness: {
    dataUpdatedAt: string | null;
    ageSeconds: number | null;
    staleAfterSeconds: number;
    stale: boolean;
  };
  summary: {
    presets: number;
    schedules: { total: number; enabled: number; disabled: number };
    runs: {
      total: number;
      carriedIn: number;
      bySource: Record<RunSource, number>;
      byOutcome: Record<RunOutcome, number>;
      manual: number;
      scheduled: number;
      sanityRetry: number;
    };
    current: {
      queuePaused: boolean;
      queueBlocked: boolean;
      running: boolean;
      task: string | null;
      runId: string | null;
    };
  };
  presets: PresetDailyStatus[];
  dataQuality: {
    empty: boolean;
    truncated: boolean;
    truncatedReasons: string[];
    orphanSchedules: Array<{ scheduleId: string; name: string; task: string; enabled: boolean }>;
    unreadablePresets: Array<{ task: string; displayName: string }>;
    unattributedRuns: { day: number; carriedIn: number };
    lookbackDays: number;
  };
  warnings: Array<{ code: string; message: string; task?: string; scheduleId?: string }>;
}

export interface DailyStatusInput {
  now: Date;
  /** Raw `?date=` value; undefined means "today in Asia/Tokyo". */
  date?: unknown;
  presets: PresetRecord[];
  schedules: ScheduleRecord[];
  runs: RunRecord[];
  engine: EngineState;
  databaseReadAt: Date;
  truncated: boolean;
  options: BuildOptions;
}

const RUN_OUTCOMES: RunOutcome[] = [
  'success',
  'success_unconfirmed',
  'queued',
  'running',
  'failed',
  'cancelled',
  'skipped',
  'interrupted',
  'unknown',
];

const RUN_SOURCES: RunSource[] = ['manual', 'schedule', 'sanity-retry', 'other'];

function emptyOutcomes(): Record<RunOutcome, number> {
  return RUN_OUTCOMES.reduce(
    (acc, outcome) => {
      acc[outcome] = 0;
      return acc;
    },
    {} as Record<RunOutcome, number>,
  );
}

function emptySources(): Record<RunSource, number> {
  return RUN_SOURCES.reduce(
    (acc, source) => {
      acc[source] = 0;
      return acc;
    },
    {} as Record<RunSource, number>,
  );
}

/** Strip anything that must never leave the service: paths, control chars, sensitive identifiers. */
export function sanitizeText(value: string, maxLength = 240): string | null {
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(PATH_TOKEN, '[path]');
  text = text.replace(SENSITIVE_VALUES, '[redacted]');
  text = text.replace(SENSITIVE_WORDS, '[redacted]');
  // A residual backslash (Windows separators, escapes) is never useful to a client.
  text = text.replace(/\\/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function classifySource(source: string): RunSource {
  return source === 'manual' || source === 'schedule' || source === 'sanity-retry' ? source : 'other';
}

export interface RunClassification {
  outcome: RunOutcome;
  completionConfidence: CompletionConfidence;
  subtasksConfirmed: boolean | null;
}

export function classifyRun(status: string, reason: string | null): RunClassification {
  switch (status) {
    case 'success': {
      if (UNCONFIRMED_REASON.test(reason ?? '')) {
        return { outcome: 'success_unconfirmed', completionConfidence: 'unconfirmed', subtasksConfirmed: false };
      }
      return { outcome: 'success', completionConfidence: 'confirmed', subtasksConfirmed: true };
    }
    case 'queued':
      return { outcome: 'queued', completionConfidence: 'unavailable', subtasksConfirmed: null };
    case 'running':
      return { outcome: 'running', completionConfidence: 'unavailable', subtasksConfirmed: null };
    case 'failed':
    case 'cancelled':
    case 'skipped':
    case 'interrupted':
      return { outcome: status, completionConfidence: 'unavailable', subtasksConfirmed: null };
    default:
      return { outcome: 'unknown', completionConfidence: 'unavailable', subtasksConfirmed: null };
  }
}

/**
 * Account-related facts are limited to booleans: never an account name, matcher or login.
 * `identityConfirmation` is intentionally `unavailable`: these flags describe the stored preset, and
 * identity is established per run by the sequence probe, which blocks the run when it cannot confirm.
 * A preset can therefore never claim `confirmed`/`unconfirmed`.
 */
export function presetAccountFlags(raw: string | null): AccountFlags {
  const fallback: AccountFlags = { accountSwitchConfigured: false, identityConfirmation: 'unavailable' };
  if (!raw) return fallback;
  try {
    const plan = analyzePresetAccount(JSON.parse(raw));
    return { accountSwitchConfigured: plan.switchRequested === true, identityConfirmation: 'unavailable' };
  } catch {
    return fallback;
  }
}

function effectiveStart(run: RunRecord): Date {
  return run.startedAt ?? run.createdAt;
}

function compareRuns(a: RunRecord, b: RunRecord): number {
  const at = a.createdAt.getTime() - b.createdAt.getTime();
  return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function makeRunItem(run: RunRecord, crossMidnight: boolean): RunItem {
  const classified = classifyRun(run.status, run.reason);
  const durationSeconds =
    run.startedAt && run.finishedAt
      ? Math.max(0, Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000))
      : null;
  return {
    id: run.id,
    task: run.task,
    source: classifySource(run.source),
    status: run.status,
    outcome: classified.outcome,
    completionConfidence: classified.completionConfidence,
    subtasksConfirmed: classified.subtasksConfirmed,
    createdAt: formatJst(run.createdAt) ?? '',
    startedAt: formatJst(run.startedAt),
    finishedAt: formatJst(run.finishedAt),
    exitCode: run.exitCode,
    durationSeconds,
    reason: sanitizeText(run.reason ?? ''),
    crossMidnight,
    occurrence: run.occurrence,
  };
}

function makeOutcomeCounts(items: RunItem[]): OutcomeCounts {
  const byOutcome = emptyOutcomes();
  for (const item of items) byOutcome[item.outcome] += 1;
  return { count: items.length, byOutcome };
}

function tallySources(items: RunItem[]): Record<RunSource, number> {
  const bySource = emptySources();
  for (const item of items) bySource[item.source] += 1;
  return bySource;
}

function maxDate(dates: Array<Date | null | undefined>): Date | null {
  let max: Date | null = null;
  for (const date of dates) {
    if (!date || !Number.isFinite(date.getTime())) continue;
    if (!max || date.getTime() > max.getTime()) max = date;
  }
  return max;
}

function minOrNull(dates: Date[]): string | null {
  if (dates.length === 0) return null;
  const min = dates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  return formatJst(min);
}

/**
 * Build the daily-status document. Throws `PublicApiError` for an invalid or out-of-range date;
 * every other failure is a programming/storage error and must be mapped to a generic 500 by the
 * service layer.
 */
export function buildDailyStatus(input: DailyStatusInput): DailyStatusResponse {
  const dateKey = resolveDateKey(input.date, input.now, input.options.maxLookbackDays);
  const window: DayWindow = dayWindow(dateKey);
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  const nowMs = input.now.getTime();

  const dayRuns: RunRecord[] = [];
  const carriedRuns: RunRecord[] = [];
  for (const run of input.runs) {
    const startedAt = effectiveStart(run).getTime();
    if (startedAt >= startMs && startedAt < endMs) {
      dayRuns.push(run);
    } else if (startedAt < startMs && (!run.finishedAt || run.finishedAt.getTime() >= startMs)) {
      carriedRuns.push(run);
    }
  }
  dayRuns.sort(compareRuns);
  carriedRuns.sort(compareRuns);

  const presets = [...input.presets].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
  const presetTasks = new Set(presets.map((preset) => preset.task));
  const schedulesByTask = new Map<string, ScheduleRecord[]>();
  for (const schedule of input.schedules) {
    const list = schedulesByTask.get(schedule.task) ?? [];
    list.push(schedule);
    schedulesByTask.set(schedule.task, list);
  }
  const runsByTask = new Map<string, RunRecord[]>();
  for (const run of dayRuns) {
    const list = runsByTask.get(run.task) ?? [];
    list.push(run);
    runsByTask.set(run.task, list);
  }
  const carriedByTask = new Map<string, RunRecord[]>();
  for (const run of carriedRuns) {
    const list = carriedByTask.get(run.task) ?? [];
    list.push(run);
    carriedByTask.set(run.task, list);
  }
  const runsByOccurrence = new Map<string, RunRecord[]>();
  for (const run of dayRuns) {
    if (!run.occurrence) continue;
    const list = runsByOccurrence.get(run.occurrence) ?? [];
    list.push(run);
    runsByOccurrence.set(run.occurrence, list);
  }

  const warnings: DailyStatusResponse['warnings'] = [];
  const truncatedReasons: string[] = [];
  if (input.truncated) {
    truncatedReasons.push('row_cap');
    warnings.push({ code: 'result_truncated', message: 'Storage query reached its row cap; totals may be incomplete' });
  }

  const orphanSchedules: DailyStatusResponse['dataQuality']['orphanSchedules'] = [];
  const warningsSeen = new Set<string>();
  for (const schedule of input.schedules) {
    if (presetTasks.has(schedule.task)) continue;
    orphanSchedules.push({
      scheduleId: schedule.id,
      name: sanitizeText(schedule.name, 120) ?? '',
      task: schedule.task,
      enabled: schedule.enabled,
    });
    if (!warningsSeen.has(`orphan:${schedule.task}`)) {
      warningsSeen.add(`orphan:${schedule.task}`);
      warnings.push({
        code: 'orphan_schedule',
        message: 'Schedule references a preset that is not present; reported under dataQuality.orphanSchedules',
        task: schedule.task,
      });
    }
  }

  const unreadablePresets: DailyStatusResponse['dataQuality']['unreadablePresets'] = [];
  for (const preset of presets) {
    if (!preset.unreadable) continue;
    unreadablePresets.push({ task: preset.task, displayName: sanitizeText(preset.displayName, 200) ?? '' });
    warnings.push({
      code: 'unreadable_preset',
      message: 'Preset file could not be read; its schedule/run rows are still reported',
      task: preset.task,
    });
  }

  const dayUnattributed = dayRuns.filter((run) => !presetTasks.has(run.task));
  const carriedUnattributed = carriedRuns.filter((run) => !presetTasks.has(run.task));
  const unattributedTasks = new Set([...dayUnattributed, ...carriedUnattributed].map((run) => run.task));
  for (const task of unattributedTasks) {
    warnings.push({
      code: 'run_without_preset',
      message: 'Run refers to a preset that is not present; excluded from preset statistics',
      task,
    });
  }

  const unknownSources = new Set<string>();
  for (const run of [...dayRuns, ...carriedRuns]) {
    if (classifySource(run.source) === 'other') unknownSources.add(run.source);
  }
  for (const source of unknownSources) {
    warnings.push({
      code: 'unknown_run_source',
      message: `Run source ${JSON.stringify(source).slice(0, 40)} is not manual/schedule/sanity-retry; excluded from manual and scheduled statistics`,
    });
  }

  const presetEntries: PresetDailyStatus[] = [];
  for (const preset of presets) {
    const presetDayRuns = runsByTask.get(preset.task) ?? [];
    const presetCarriedRuns = carriedByTask.get(preset.task) ?? [];
    const schedules = [...(schedulesByTask.get(preset.task) ?? [])].sort((a, b) => {
      const at = a.nextAt.getTime() - b.nextAt.getTime();
      return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const dayItems: RunItem[] = presetDayRuns.map((run) => {
      const crossMidnight = run.finishedAt === null || run.finishedAt.getTime() >= endMs;
      return makeRunItem(run, crossMidnight);
    });
    const carriedItems: RunItem[] = presetCarriedRuns.map((run) => makeRunItem(run, true));

    const plan: PlanOccurrence[] = [];
    let planTruncated = false;
    for (const schedule of schedules) {
      const expansion = expandOccurrences(schedule, window);
      if (expansion.invalid) {
        warnings.push({
          code: 'invalid_schedule_rule',
          message: 'Schedule rule could not be expanded; its occurrences are missing from the plan',
          task: preset.task,
          scheduleId: schedule.id,
        });
        continue;
      }
      if (expansion.truncated) planTruncated = true;
      for (const at of expansion.occurrences) {
        const occurrenceKey = `${schedule.id}:${at.toISOString()}`;
        const matched = runsByOccurrence.get(occurrenceKey);
        const first = matched?.[0];
        const atMs = at.getTime();
        // A future occurrence is `pending` even if a stray/foreign row claims its occurrence key:
        // the API must never report future work as completed.
        const state: PlanOccurrence['state'] = atMs >= nowMs ? 'pending' : first ? 'executed' : 'missed';
        plan.push({
          at: formatJst(at) ?? '',
          scheduleId: schedule.id,
          scheduleName: sanitizeText(schedule.name, 120) ?? '',
          type: schedule.type,
          expression: schedule.expression,
          state,
          missedReason:
            state === 'missed' ? (input.engine.queuePaused ? 'queue_paused' : 'no_run_recorded') : null,
          runId: state === 'executed' ? (first?.id ?? null) : null,
          runOutcome: state === 'executed' && first ? classifyRun(first.status, first.reason).outcome : null,
          additionalRuns: state === 'executed' && matched && matched.length > 1 ? matched.length - 1 : 0,
        });
      }
    }
    plan.sort((a, b) => {
      const at = Date.parse(a.at) - Date.parse(b.at);
      return at !== 0 ? at : a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0;
    });
    if (plan.length > MAX_PLAN_OCCURRENCES_PER_PRESET) {
      plan.length = MAX_PLAN_OCCURRENCES_PER_PRESET;
      planTruncated = true;
    }
    if (planTruncated) {
      truncatedReasons.push('plan_cap');
      warnings.push({
        code: 'plan_truncated',
        message: 'Planned occurrences were capped for this day',
        task: preset.task,
      });
    }

    const scheduleSummaries: ScheduleSummary[] = schedules.map((schedule) => ({
      id: schedule.id,
      name: sanitizeText(schedule.name, 120) ?? '',
      type: schedule.type,
      expression: schedule.expression,
      enabled: schedule.enabled,
      nextAt: formatJst(schedule.nextAt),
      nextScheduledAt: formatJst(nextRunFor(schedule, input.now)),
    }));
    const nextDates = schedules
      .map((schedule) => nextRunFor(schedule, input.now))
      .filter((date): date is Date => !!date);
    const nextScheduledAt = minOrNull(nextDates);

    const manualItems = dayItems.filter((item) => item.source === 'manual');
    const scheduledItems = dayItems.filter((item) => item.source === 'schedule');
    const sanityItems = dayItems.filter((item) => item.source === 'sanity-retry');
    const otherItems = dayItems.filter((item) => item.source === 'other');
    const byOutcome = emptyOutcomes();
    for (const item of dayItems) byOutcome[item.outcome] += 1;

    const allPresetRuns = [...presetDayRuns, ...presetCarriedRuns];
    const runningRun = allPresetRuns.find((run) => run.status === 'running');
    const activeRun = runningRun ?? allPresetRuns.find((run) => run.id === input.engine.currentRunId);
    const queuedCount = allPresetRuns.filter((run) => run.status === 'queued').length;
    const account = presetAccountFlags(preset.raw);

    presetEntries.push({
      task: preset.task,
      displayName: sanitizeText(preset.displayName, 200) ?? preset.task,
      unreadable: preset.unreadable,
      accountSwitchConfigured: account.accountSwitchConfigured,
      identityConfirmation: account.identityConfirmation,
      plan,
      schedules: scheduleSummaries,
      runs: {
        total: dayItems.length,
        items: dayItems,
        byOutcome,
        bySource: tallySources(dayItems),
        manual: makeOutcomeCounts(manualItems),
        scheduled: makeOutcomeCounts(scheduledItems),
        sanityRetry: makeOutcomeCounts(sanityItems),
        other: makeOutcomeCounts(otherItems),
      },
      carriedIn: { count: carriedItems.length, items: carriedItems },
      current: {
        queuePaused: input.engine.queuePaused,
        queueBlocked: input.engine.queueBlocked,
        running: !!runningRun,
        runId: activeRun?.id ?? null,
        status: activeRun?.status ?? null,
        since: formatJst((activeRun?.startedAt ?? activeRun?.createdAt) ?? null),
        queuedCount,
      },
      nextScheduledAt,
    });
  }

  const allDayItems = presetEntries.flatMap((preset) => preset.runs.items);
  const allCarriedItems = presetEntries.flatMap((preset) => preset.carriedIn.items);
  const byOutcome = emptyOutcomes();
  for (const item of allDayItems) byOutcome[item.outcome] += 1;
  const bySource = tallySources(allDayItems);

  const dataUpdatedAt = maxDate(
    [...dayRuns, ...carriedRuns].flatMap((run) => [run.createdAt, run.startedAt ?? null, run.finishedAt ?? null]),
  );
  const ageSeconds =
    dataUpdatedAt === null ? null : Math.max(0, Math.floor((nowMs - dataUpdatedAt.getTime()) / 1000));
  const staleAfterSeconds = input.options.staleAfterSeconds;
  const empty = input.presets.length === 0 && input.schedules.length === 0 && input.runs.length === 0;
  const uniqueTruncated = [...new Set(truncatedReasons)];

  // Explicit compatibility mode is surfaced, never hidden: every account preset gets a warning,
  // and the root field lets a bot tell "unverified but configured to continue" from a real success.
  const accountPolicy: AccountIdentityPolicy = input.engine.accountIdentityPolicy ?? 'require-verified';
  if (accountPolicy === 'warn-continue') {
    for (const preset of presetEntries) {
      if (preset.accountSwitchConfigured) {
        warnings.push({
          code: 'account_identity_unverified_compat',
          message: 'Account identity compatibility mode: a completed StartUp continues without identity verification; tasks may run on the wrong account (explicitly configured, not verification).',
          task: preset.task,
        });
      }
    }
  }

  const currentTask = presetEntries.find((preset) =>
      input.engine.currentRunId
        ? preset.runs.items.some((item) => item.id === input.engine.currentRunId) ||
          preset.carriedIn.items.some((item) => item.id === input.engine.currentRunId)
        : false,
    )?.task ?? null;

  return {
    generatedAt: formatJst(input.now) ?? '',
    timeZone: 'Asia/Tokyo',
    accountPolicy,
    date: dateKey,
    dayWindow: { start: formatJst(window.start) ?? '', end: formatJst(window.end) ?? '' },
    databaseReadAt: formatJst(input.databaseReadAt) ?? '',
    freshness: {
      dataUpdatedAt: formatJst(dataUpdatedAt),
      ageSeconds,
      staleAfterSeconds,
      stale: ageSeconds !== null && ageSeconds > staleAfterSeconds,
    },
    summary: {
      presets: presetEntries.length,
      schedules: {
        total: input.schedules.length,
        enabled: input.schedules.filter((schedule) => schedule.enabled).length,
        disabled: input.schedules.filter((schedule) => !schedule.enabled).length,
      },
      runs: {
        total: allDayItems.length,
        carriedIn: allCarriedItems.length,
        bySource,
        byOutcome,
        manual: allDayItems.filter((item) => item.source === 'manual').length,
        scheduled: allDayItems.filter((item) => item.source === 'schedule').length,
        sanityRetry: allDayItems.filter((item) => item.source === 'sanity-retry').length,
      },
      current: {
        queuePaused: input.engine.queuePaused,
        queueBlocked: input.engine.queueBlocked,
        running: input.engine.running,
        task: currentTask,
        runId: input.engine.currentRunId,
      },
    },
    presets: presetEntries,
    dataQuality: {
      empty,
      truncated: uniqueTruncated.length > 0,
      truncatedReasons: uniqueTruncated,
      orphanSchedules,
      unreadablePresets,
      unattributedRuns: { day: dayUnattributed.length, carriedIn: carriedUnattributed.length },
      lookbackDays: input.options.maxLookbackDays,
    },
    warnings,
  };
}
