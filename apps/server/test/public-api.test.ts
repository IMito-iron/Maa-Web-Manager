/**
 * Contract tests for the read-only Bot daily-status API.
 *
 * Everything runs against the pure builder, the application service (with a fake read-only
 * repository) and a real temporary SQLite database for the Prisma adapter. The clock is always
 * injected; no test sleeps, and the rate-limit test advances the clock by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { buildDailyStatus, classifyRun, sanitizeText, type DailyStatusInput } from '../src/public-api/daily-status';
import { resolveDateKey, formatJst, jstDateKey, dayWindow } from '../src/public-api/jst';
import { cronFor, expandOccurrences, intervalMinutes } from '../src/public-api/occurrences';
import { PublicApiError } from '../src/public-api/errors';
import { PublicApiService, type ApiRequest, type ApiResponse } from '../src/public-api/service';
import { servePublicEndpoint } from '../src/public-api/http';
import { BOT_API_DEFAULTS, botApiOptions } from '../src/public-api/options';
import { digestToken, loadBotTokens, parseBearer, splitTokens, verifyBearer } from '../src/public-api/tokens';
import { PrismaDailyStatusRepository, type PresetSource } from '../src/public-api/repository';
import type {
  EngineState,
  PresetRecord,
  PublicApiRepository,
  RunRecord,
  ScheduleRecord,
  SnapshotRead,
} from '../src/public-api/contracts';
import type { DayWindow } from '../src/public-api/jst';
import type { TokenLoadResult } from '../src/public-api/tokens';

const NOW = new Date('2026-11-06T12:00:00+09:00');
const NOW_MS = NOW.getTime();
const TOKEN = 'test-token-0123456789abcdef';
const SECOND_TOKEN = 'rotated-token-fedcba9876543210';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function tokenSet(...values: string[]): TokenLoadResult {
  return {
    configured: values.length > 0,
    digests: values.map(digestToken),
    source: values.length > 0 ? 'env' : 'none',
  };
}

function makeRun(input: {
  id: string;
  task: string;
  status?: string;
  source?: string;
  start?: string;
  end?: string | null;
  created?: string;
  occurrence?: string | null;
  scheduleId?: string | null;
  reason?: string | null;
  exitCode?: number | null;
}): RunRecord {
  const created = new Date(input.created ?? input.start ?? '2026-11-06T09:00:00+09:00');
  return {
    id: input.id,
    task: input.task,
    status: input.status ?? 'success',
    source: input.source ?? 'manual',
    scheduleId: input.scheduleId ?? null,
    occurrence: input.occurrence ?? null,
    createdAt: created,
    startedAt: input.start ? new Date(input.start) : null,
    finishedAt: input.end === null ? null : new Date(input.end ?? input.start ?? created),
    exitCode: input.exitCode ?? 0,
    reason: input.reason ?? null,
  };
}

function makeSchedule(input: {
  id?: string;
  task: string;
  type?: string;
  expression: string;
  enabled?: boolean;
  nextAt?: string;
  createdAt?: string;
  name?: string;
}): ScheduleRecord {
  return {
    id: input.id ?? `schedule-${input.task}-${input.expression.replace(/[^0-9a-z]/gi, '')}`,
    name: input.name ?? `Schedule ${input.expression}`,
    task: input.task,
    type: input.type ?? 'daily',
    expression: input.expression,
    enabled: input.enabled ?? true,
    nextAt: new Date(input.nextAt ?? '2026-11-06T18:00:00+09:00'),
    createdAt: new Date(input.createdAt ?? '2026-11-01T00:00:00+09:00'),
  };
}

function makePreset(task: string, doc?: any): PresetRecord {
  const document = doc ?? { name: `Preset ${task}`, tasks: [{ type: 'Fight', params: { stage: 'LS-6', times: 1 } }] };
  return { task, displayName: `Preset ${task}`, raw: JSON.stringify(document), unreadable: false };
}

const IDLE_ENGINE: EngineState = {
  queuePaused: false,
  queueBlocked: false,
  running: false,
  currentRunId: null,
  controlHeld: false,
};

class FakeRepository implements PublicApiRepository {
  reads: Array<{ window: DayWindow; takeCap: number }> = [];
  constructor(
    private readonly data: {
      presets?: PresetRecord[];
      schedules?: ScheduleRecord[];
      runs?: RunRecord[];
      truncated?: boolean;
      databaseReadAt?: Date;
      fail?: Error;
    } = {},
  ) {}
  async readSnapshot(window: DayWindow, takeCap: number): Promise<SnapshotRead> {
    this.reads.push({ window, takeCap });
    if (this.data.fail) throw this.data.fail;
    return {
      presets: this.data.presets ?? [],
      schedules: this.data.schedules ?? [],
      runs: this.data.runs ?? [],
      truncated: this.data.truncated ?? false,
      databaseReadAt: this.data.databaseReadAt ?? NOW,
    };
  }
}

interface ServiceHarness {
  service: PublicApiService;
  repository: FakeRepository;
  logs: string[];
  clock: { ms: number };
}

function makeService(
  overrides: {
    repository?: PublicApiRepository;
    engine?: EngineState;
    tokens?: TokenLoadResult;
    options?: Partial<typeof BOT_API_DEFAULTS>;
    clock?: () => Date;
    uptimeSeconds?: number;
    logs?: string[];
  } = {},
): ServiceHarness {
  const repository = (overrides.repository as FakeRepository) ?? new FakeRepository();
  const logs = overrides.logs ?? [];
  const clock = { ms: NOW_MS };
  const service = new PublicApiService({
    repository,
    engine: { read: async () => overrides.engine ?? IDLE_ENGINE },
    tokens: overrides.tokens ?? tokenSet(TOKEN),
    options: { ...BOT_API_DEFAULTS, ...overrides.options },
    now: overrides.clock ?? (() => new Date(clock.ms)),
    uptimeSeconds: () => overrides.uptimeSeconds ?? 1234,
    logger: (line) => logs.push(line),
  });
  return { service, repository, logs, clock };
}

function apiRequest(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
    query: {},
    ...overrides,
  };
}

function withDate(value: unknown): ApiRequest {
  return apiRequest({ query: { date: value } });
}

async function daily(harness: ServiceHarness, request: ApiRequest = apiRequest()): Promise<ApiResponse> {
  return harness.service.handleDailyStatus(request);
}

function dataOf(response: ApiResponse): any {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function withHttpServer(
  service: PublicApiService,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.all('/api/v1/public/health', (req, res) => void servePublicEndpoint(service, 'health', req, res));
  app.all('/api/v1/public/daily-status', (req, res) => void servePublicEndpoint(service, 'daily-status', req, res));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------------------------
// JST day boundaries and time formatting
// ---------------------------------------------------------------------------------------------

test('JST calendar day windows use +09:00 and include 23:59:59 but not 00:00:00 of the next day', async () => {
  const preset = makePreset('preset-a');
  const lastSecond = makeRun({ id: 'r-last', task: 'preset-a', start: '2026-11-06T23:59:59+09:00', end: '2026-11-07T00:00:00+09:00' });
  const nextMidnight = makeRun({ id: 'r-next', task: 'preset-a', start: '2026-11-07T00:00:00+09:00', end: '2026-11-07T00:05:00+09:00' });
  const harness = makeService({
    repository: new FakeRepository({ presets: [preset], runs: [lastSecond, nextMidnight] }),
  });
  const nextDayHarness = makeService({
    repository: new FakeRepository({ presets: [preset], runs: [lastSecond, nextMidnight] }),
    clock: () => new Date('2026-11-07T00:00:30+09:00'),
  });

  const today = dataOf(await daily(harness));
  assert.equal(today.date, '2026-11-06');
  assert.deepEqual(today.dayWindow, {
    start: '2026-11-06T00:00:00.000+09:00',
    end: '2026-11-07T00:00:00.000+09:00',
  });
  assert.deepEqual(today.presets[0].runs.items.map((item: any) => item.id), ['r-last']);

  const tomorrow = dataOf(await daily(nextDayHarness, withDate('2026-11-07')));
  assert.deepEqual(tomorrow.presets[0].runs.items.map((item: any) => item.id), ['r-next']);
  // Timestamps always carry the JST offset; no `Z` timestamps leak into the contract.
  assert.match(today.generatedAt, /\+09:00$/);
  assert.match(today.presets[0].runs.items[0].startedAt, /\+09:00$/);
  assert.doesNotMatch(JSON.stringify(today), /\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
});

test('default date is the Asia/Tokyo calendar day of the injected clock', async () => {
  const harness = makeService({
    clock: () => new Date('2026-11-07T00:30:00+09:00'),
    repository: new FakeRepository({ presets: [makePreset('preset-a')] }),
  });
  assert.equal(dataOf(await daily(harness)).date, '2026-11-07');
  assert.equal(resolveDateKey(undefined, new Date('2026-11-07T00:30:00+09:00'), 7), '2026-11-07');
});

// ---------------------------------------------------------------------------------------------
// Cross-midnight runs (both directions)
// ---------------------------------------------------------------------------------------------

test('cross-midnight: a run started today and finished tomorrow stays in today with crossMidnight', async () => {
  const run = makeRun({
    id: 'r-span',
    task: 'preset-a',
    start: '2026-11-06T23:30:00+09:00',
    end: '2026-11-07T00:30:00+09:00',
  });
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], runs: [run] }) });
  const body = dataOf(await daily(harness));
  const item = body.presets[0].runs.items[0];
  assert.equal(item.crossMidnight, true);
  assert.equal(item.startedAt, '2026-11-06T23:30:00.000+09:00');
  assert.equal(item.finishedAt, '2026-11-07T00:30:00.000+09:00');
  assert.equal(body.presets[0].carriedIn.count, 0);
  assert.equal(body.summary.runs.manual, 1);
});

test('cross-midnight: a run started yesterday and finished today is carriedIn only', async () => {
  const run = makeRun({
    id: 'r-carried',
    task: 'preset-a',
    start: '2026-11-05T23:00:00+09:00',
    end: '2026-11-06T00:10:00+09:00',
  });
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], runs: [run] }) });
  const body = dataOf(await daily(harness));
  const preset = body.presets[0];
  assert.equal(preset.runs.total, 0, 'carried-in run must not enter the day counts');
  assert.equal(preset.runs.manual.count, 0);
  assert.equal(preset.carriedIn.count, 1);
  assert.equal(preset.carriedIn.items[0].id, 'r-carried');
  assert.equal(body.summary.runs.manual, 0);
  assert.equal(body.summary.runs.carriedIn, 1);
  assert.equal(body.presets[0].current.running, false);
});

test('cross-midnight: an unfinished run from yesterday is carriedIn and reported as running', async () => {
  const run = makeRun({
    id: 'r-open',
    task: 'preset-a',
    status: 'running',
    start: '2026-11-05T22:00:00+09:00',
    end: null,
  });
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')], runs: [run] }),
    engine: { ...IDLE_ENGINE, running: true, currentRunId: 'r-open' },
  });
  const body = dataOf(await daily(harness));
  assert.equal(body.presets[0].carriedIn.items[0].outcome, 'running');
  assert.equal(body.presets[0].current.running, true);
  assert.equal(body.presets[0].current.runId, 'r-open');
  assert.equal(body.summary.current.task, 'preset-a');
  assert.equal(body.summary.current.running, true);
});

// ---------------------------------------------------------------------------------------------
// Runs: multiple per day, classification, isolation
// ---------------------------------------------------------------------------------------------

test('multiple runs of one preset in one day are all listed and counted by source and outcome', async () => {
  const runs = [
    makeRun({ id: 'r1', task: 'preset-a', status: 'success', start: '2026-11-06T06:00:00+09:00' }),
    makeRun({
      id: 'r2',
      task: 'preset-a',
      status: 'success',
      start: '2026-11-06T18:00:00+09:00',
      end: '2026-11-06T18:10:00+09:00',
      reason: '理智未耗尽：按游戏「上次作战」的关卡没有用尽理智',
    }),
    makeRun({ id: 'r3', task: 'preset-a', status: 'failed', start: '2026-11-06T19:00:00+09:00', exitCode: 1 }),
    makeRun({ id: 'r4', task: 'preset-a', status: 'success', source: 'schedule', start: '2026-11-06T07:00:00+09:00' }),
    makeRun({ id: 'r5', task: 'preset-a', status: 'queued', source: 'sanity-retry', created: '2026-11-06T11:00:00+09:00', end: null }),
  ];
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], runs }) });
  const body = dataOf(await daily(harness));
  const preset = body.presets[0];
  assert.equal(preset.runs.total, 5);
  const outcomeById = new Map(preset.runs.items.map((item: any) => [item.id, item.outcome]));
  assert.equal(outcomeById.get('r1'), 'success');
  assert.equal(outcomeById.get('r2'), 'success_unconfirmed');
  assert.equal(outcomeById.get('r3'), 'failed');
  assert.equal(outcomeById.get('r4'), 'success');
  assert.equal(outcomeById.get('r5'), 'queued');
  assert.equal(preset.runs.manual.count, 3);
  assert.equal(preset.runs.scheduled.count, 1);
  assert.equal(preset.runs.sanityRetry.count, 1);
  assert.equal(preset.runs.other.count, 0);
  assert.equal(preset.runs.bySource.schedule, 1);
  assert.equal(preset.runs.bySource['sanity-retry'], 1);
  assert.equal(body.summary.runs.total, 5);
  assert.equal(body.summary.runs.manual, 3);
  assert.equal(body.summary.runs.scheduled, 1);
  assert.equal(body.summary.runs.sanityRetry, 1);
});

test('outcome mapping: success vs success_unconfirmed vs failed/cancelled/skipped/interrupted', () => {
  const confirmed = classifyRun('success', null);
  assert.equal(confirmed.outcome, 'success');
  assert.equal(confirmed.completionConfidence, 'confirmed');
  assert.equal(confirmed.subtasksConfirmed, true);

  for (const reason of [
    '理智未耗尽：按游戏「上次作战」的关卡没有用尽理智',
    'Completed but unconfirmed by the game',
    'TaskChainError: fight chain failed',
    'SubTaskError: some sub task failed',
    'ACCOUNT_IDENTITY_UNVERIFIED',
  ]) {
    const classified = classifyRun('success', reason);
    assert.equal(classified.outcome, 'success_unconfirmed', reason);
    assert.equal(classified.completionConfidence, 'unconfirmed');
    assert.equal(classified.subtasksConfirmed, false);
  }

  const cases: Array<[string, string]> = [
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['skipped', 'skipped'],
    ['interrupted', 'interrupted'],
    ['queued', 'queued'],
    ['running', 'running'],
    ['something-new', 'unknown'],
  ];
  for (const [status, outcome] of cases) {
    const classified = classifyRun(status, null);
    assert.equal(classified.outcome, outcome);
    assert.equal(classified.completionConfidence, 'unavailable');
    assert.equal(classified.subtasksConfirmed, null);
  }
});

test('cross-preset isolation: runs and schedules never mix between presets', async () => {
  const schedules = [
    makeSchedule({ id: 's-a', task: 'preset-a', expression: '06:00', nextAt: '2026-11-06T06:00:00+09:00' }),
    makeSchedule({ id: 's-b', task: 'preset-b', expression: '18:00', nextAt: '2026-11-06T18:00:00+09:00' }),
  ];
  const runs = [
    makeRun({
      id: 'r-a',
      task: 'preset-a',
      source: 'schedule',
      scheduleId: 's-a',
      occurrence: `s-a:${new Date('2026-11-06T06:00:00+09:00').toISOString()}`,
      start: '2026-11-06T06:00:00+09:00',
    }),
    makeRun({ id: 'r-b', task: 'preset-b', start: '2026-11-06T08:00:00+09:00' }),
  ];
  const harness = makeService({
    repository: new FakeRepository({
      presets: [makePreset('preset-a'), makePreset('preset-b')],
      schedules,
      runs,
    }),
  });
  const body = dataOf(await daily(harness));
  const a = body.presets.find((preset: any) => preset.task === 'preset-a');
  const b = body.presets.find((preset: any) => preset.task === 'preset-b');
  assert.deepEqual(a.runs.items.map((item: any) => item.id), ['r-a']);
  assert.deepEqual(b.runs.items.map((item: any) => item.id), ['r-b']);
  assert.deepEqual(a.schedules.map((schedule: any) => schedule.id), ['s-a']);
  assert.deepEqual(b.schedules.map((schedule: any) => schedule.id), ['s-b']);
  assert.equal(a.runs.scheduled.count, 1);
  assert.equal(b.runs.scheduled.count, 0);
  assert.equal(b.plan.length, 1);
  assert.deepEqual(
    b.plan.map((occurrence: any) => occurrence.state),
    ['pending'],
  );
});

// ---------------------------------------------------------------------------------------------
// Schedule plan: executed / missed / pending, paused queue, disabled schedules, multiple matches
// ---------------------------------------------------------------------------------------------

test('schedule occurrences: executed, missed, pending, and a future occurrence is never executed', async () => {
  const schedules = [
    makeSchedule({
      id: 's-06',
      task: 'preset-a',
      expression: '06:00',
      nextAt: '2026-11-06T06:00:00+09:00',
    }),
    makeSchedule({
      id: 's-09',
      task: 'preset-a',
      expression: '09:00',
      nextAt: '2026-11-06T09:00:00+09:00',
    }),
    makeSchedule({
      id: 's-18',
      task: 'preset-a',
      expression: '18:00',
      nextAt: '2026-11-06T18:00:00+09:00',
    }),
  ];
  const occurrence06 = `${'s-06'}:${new Date('2026-11-06T06:00:00+09:00').toISOString()}`;
  const occurrence18 = `${'s-18'}:${new Date('2026-11-06T18:00:00+09:00').toISOString()}`;
  const runs = [
    makeRun({
      id: 'r-06',
      task: 'preset-a',
      source: 'schedule',
      scheduleId: 's-06',
      occurrence: occurrence06,
      start: '2026-11-06T06:00:01+09:00',
    }),
    // Corrupt/foreign row: a run claiming the 18:00 occurrence even though 18:00 is still future.
    makeRun({
      id: 'r-future',
      task: 'preset-a',
      source: 'schedule',
      scheduleId: 's-18',
      occurrence: occurrence18,
      start: '2026-11-06T18:00:00+09:00',
    }),
  ];
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], schedules, runs }) });
  const body = dataOf(await daily(harness));
  const plan = body.presets[0].plan;
  const bySchedule = new Map(plan.map((occurrence: any) => [occurrence.scheduleId, occurrence]));
  assert.equal((bySchedule.get('s-06') as any).state, 'executed');
  assert.equal((bySchedule.get('s-06') as any).runId, 'r-06');
  assert.equal((bySchedule.get('s-09') as any).state, 'missed');
  assert.equal((bySchedule.get('s-09') as any).missedReason, 'no_run_recorded');
  assert.equal((bySchedule.get('s-18') as any).state, 'pending', 'a future occurrence is never executed');
  assert.equal((bySchedule.get('s-18') as any).runId, null, 'future occurrences never claim a run');
});

test('paused queue marks past, run-less occurrences with missedReason queue_paused', async () => {
  const schedule = makeSchedule({ id: 's-06', task: 'preset-a', expression: '06:00' });
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')], schedules: [schedule] }),
    engine: { ...IDLE_ENGINE, queuePaused: true },
  });
  const body = dataOf(await daily(harness));
  assert.equal(body.presets[0].plan[0].state, 'missed');
  assert.equal(body.presets[0].plan[0].missedReason, 'queue_paused');
  assert.equal(body.presets[0].current.queuePaused, true);
  assert.equal(body.summary.current.queuePaused, true);
  assert.equal(body.presets[0].current.queueBlocked, false);
});

test('multiple runs for one scheduled occurrence count as executed once with additionalRuns', async () => {
  const schedule = makeSchedule({ id: 's-06', task: 'preset-a', expression: '06:00' });
  const occurrence = `s-06:${new Date('2026-11-06T06:00:00+09:00').toISOString()}`;
  const runs = [
    makeRun({ id: 'r-first', task: 'preset-a', source: 'schedule', scheduleId: 's-06', occurrence, start: '2026-11-06T06:00:01+09:00' }),
    makeRun({ id: 'r-second', task: 'preset-a', source: 'schedule', scheduleId: 's-06', occurrence, start: '2026-11-06T06:10:00+09:00' }),
  ];
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], schedules: [schedule], runs }) });
  const body = dataOf(await daily(harness));
  const plan = body.presets[0].plan;
  assert.equal(plan.length, 1);
  assert.equal(plan[0].state, 'executed');
  assert.equal(plan[0].runId, 'r-first');
  assert.equal(plan[0].additionalRuns, 1);
  assert.equal(body.presets[0].runs.total, 2);
});

test('disabled schedules produce no planned occurrences but their rows are still reported', async () => {
  const schedule = makeSchedule({ id: 's-off', task: 'preset-a', expression: '06:00', enabled: false });
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], schedules: [schedule] }) });
  const body = dataOf(await daily(harness));
  assert.deepEqual(body.presets[0].plan, []);
  assert.equal(body.presets[0].schedules[0].enabled, false);
  assert.equal(body.presets[0].schedules[0].nextScheduledAt, null);
  assert.equal(body.summary.schedules.total, 1);
  assert.equal(body.summary.schedules.disabled, 1);
});

test('schedule expansion mirrors daily/weekly/cron/interval rules in Asia/Tokyo', () => {
  assert.equal(cronFor('daily', '06:00'), '0 6 * * *');
  assert.equal(cronFor('weekly', '1,5 06:30'), '30 6 * * 1,5');
  assert.equal(cronFor('cron', '0 6,18 * * *'), '0 6,18 * * *');
  assert.equal(cronFor('daily', '25:00'), null);
  assert.equal(cronFor('weekly', '7 06:00'), null);
  assert.equal(intervalMinutes('60'), 60);
  assert.equal(intervalMinutes('0'), null);

  const window = dayWindow('2026-11-06');
  // 2026-11-06 is a Friday in Asia/Tokyo (weekday 5, 0 = Sunday).
  const weekly = makeSchedule({ id: 'w', task: 'p', type: 'weekly', expression: '5 06:00' });
  const wrongDay = makeSchedule({ id: 'w2', task: 'p', type: 'weekly', expression: '1 06:00' });
  assert.deepEqual(expandOccurrences(weekly, window).occurrences.map((date) => formatJst(date)), ['2026-11-06T06:00:00.000+09:00']);
  assert.deepEqual(expandOccurrences(wrongDay, window).occurrences, []);

  const cron = makeSchedule({ id: 'c', task: 'p', type: 'cron', expression: '0 6,18 * * *' });
  assert.deepEqual(expandOccurrences(cron, window).occurrences.map((date) => formatJst(date)), [
    '2026-11-06T06:00:00.000+09:00',
    '2026-11-06T18:00:00.000+09:00',
  ]);

  const daily = makeSchedule({ id: 'd', task: 'p', type: 'daily', expression: '00:00' });
  assert.deepEqual(expandOccurrences(daily, window).occurrences.map((date) => formatJst(date)), [
    '2026-11-06T00:00:00.000+09:00',
  ]);

  // An interval schedule fires on its own minute lattice, derived from the stored nextAt anchor.
  const interval = makeSchedule({
    id: 'i',
    task: 'p',
    type: 'interval',
    expression: '360',
    nextAt: '2026-11-06T12:00:00+09:00',
    createdAt: '2026-11-01T00:00:00+09:00',
  });
  assert.deepEqual(expandOccurrences(interval, window).occurrences.map((date) => formatJst(date)), [
    '2026-11-06T00:00:00.000+09:00',
    '2026-11-06T06:00:00.000+09:00',
    '2026-11-06T12:00:00.000+09:00',
    '2026-11-06T18:00:00.000+09:00',
  ]);
});

test('occurrences before the schedule was created are not invented', () => {
  const schedule = makeSchedule({
    id: 's-new',
    task: 'preset-a',
    expression: '06:00',
    createdAt: '2026-11-06T12:00:00+09:00',
  });
  const window = dayWindow('2026-11-06');
  assert.deepEqual(expandOccurrences(schedule, window).occurrences, []);
});

test('invalid stored schedule rules are reported in warnings instead of crashing the response', async () => {
  const schedule = makeSchedule({ id: 's-bad', task: 'preset-a', expression: 'not-a-rule', type: 'daily' });
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], schedules: [schedule] }) });
  const body = dataOf(await daily(harness));
  assert.deepEqual(body.presets[0].plan, []);
  assert.ok(body.warnings.some((warning: any) => warning.code === 'invalid_schedule_rule'));
});

// ---------------------------------------------------------------------------------------------
// Running / paused / empty / orphan / unreadable
// ---------------------------------------------------------------------------------------------

test('the currently running run is exposed through current and summary.current', async () => {
  const run = makeRun({
    id: 'r-live',
    task: 'preset-a',
    status: 'running',
    start: '2026-11-06T11:55:00+09:00',
    end: null,
  });
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')], runs: [run] }),
    engine: { ...IDLE_ENGINE, running: true, currentRunId: 'r-live' },
  });
  const body = dataOf(await daily(harness));
  assert.equal(body.presets[0].runs.items[0].outcome, 'running');
  assert.equal(body.presets[0].runs.items[0].crossMidnight, true, 'unfinished run spans the day boundary');
  assert.equal(body.presets[0].current.running, true);
  assert.equal(body.presets[0].current.runId, 'r-live');
  assert.equal(body.presets[0].current.queuedCount, 0);
  assert.equal(body.summary.current.runId, 'r-live');
  assert.equal(body.summary.current.task, 'preset-a');
});

test('empty database is a valid 200 with zeros and dataUpdatedAt null', async () => {
  const harness = makeService({ repository: new FakeRepository() });
  const body = dataOf(await daily(harness));
  assert.equal(body.date, '2026-11-06');
  assert.deepEqual(body.presets, []);
  assert.equal(body.summary.presets, 0);
  assert.deepEqual(body.summary.schedules, { total: 0, enabled: 0, disabled: 0 });
  assert.equal(body.summary.runs.total, 0);
  assert.equal(body.summary.runs.carriedIn, 0);
  assert.equal(body.dataQuality.empty, true);
  assert.equal(body.dataQuality.truncated, false);
  assert.equal(body.freshness.dataUpdatedAt, null);
  assert.equal(body.freshness.ageSeconds, null);
  assert.equal(body.freshness.stale, false);
  assert.deepEqual(body.warnings, []);
  assert.equal(body.dataQuality.lookbackDays, 7);
  assert.ok(body.dayWindow.start.endsWith('+09:00'));
});

test('orphan schedules and unreadable presets are reported, never dropped silently', async () => {
  const scheduleForMissingPreset = makeSchedule({ id: 's-orphan', task: 'preset-missing', expression: '06:00' });
  const unreadable: PresetRecord = {
    task: 'preset-broken',
    displayName: 'Broken',
    raw: null,
    unreadable: true,
  };
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a'), unreadable], schedules: [scheduleForMissingPreset] }),
  });
  const body = dataOf(await daily(harness));
  assert.deepEqual(body.dataQuality.orphanSchedules, [
    { scheduleId: 's-orphan', name: 'Schedule 06:00', task: 'preset-missing', enabled: true },
  ]);
  assert.deepEqual(body.dataQuality.unreadablePresets, [{ task: 'preset-broken', displayName: 'Broken' }]);
  assert.ok(body.warnings.some((warning: any) => warning.code === 'orphan_schedule'));
  assert.ok(body.warnings.some((warning: any) => warning.code === 'unreadable_preset'));
  const broken = body.presets.find((preset: any) => preset.task === 'preset-broken');
  assert.equal(broken.unreadable, true);
});

test('runs of a preset that no longer exists are counted separately, not attributed to another preset', async () => {
  const orphanRun = makeRun({ id: 'r-orphan', task: 'preset-gone', start: '2026-11-06T09:00:00+09:00' });
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], runs: [orphanRun] }) });
  const body = dataOf(await daily(harness));
  assert.equal(body.dataQuality.unattributedRuns.day, 1);
  assert.equal(body.summary.runs.total, 0);
  assert.ok(body.warnings.some((warning: any) => warning.code === 'run_without_preset'));
});

test('truncated storage reads are surfaced in dataQuality and warnings', async () => {
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')], truncated: true }),
  });
  const body = dataOf(await daily(harness));
  assert.equal(body.dataQuality.truncated, true);
  assert.ok(body.dataQuality.truncatedReasons.includes('row_cap'));
  assert.ok(body.warnings.some((warning: any) => warning.code === 'result_truncated'));
});

// ---------------------------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------------------------

test('freshness is computed from the newest reported run timestamp', async () => {
  const runs = [
    makeRun({ id: 'r-old', task: 'preset-a', start: '2026-11-06T09:00:00+09:00', end: '2026-11-06T09:05:00+09:00' }),
    makeRun({ id: 'r-new', task: 'preset-a', start: '2026-11-06T11:57:00+09:00', end: '2026-11-06T11:59:00+09:00' }),
  ];
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')], runs }) });
  const body = dataOf(await daily(harness));
  assert.equal(body.freshness.dataUpdatedAt, '2026-11-06T11:59:00.000+09:00');
  assert.equal(body.freshness.ageSeconds, 60);
  assert.equal(body.freshness.staleAfterSeconds, 300);
  assert.equal(body.freshness.stale, false);
  assert.equal(body.databaseReadAt, '2026-11-06T12:00:00.000+09:00');
});

// ---------------------------------------------------------------------------------------------
// Date validation and bounds
// ---------------------------------------------------------------------------------------------

test('date validation: format, impossible dates, future and too-old dates are rejected without clamping', async () => {
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')] }) });

  for (const bad of ['2026-13-01', '2026-02-30', '2026-1-1', '06-11-2026', 'tomorrow', '', '2026-11-06T00:00:00Z', ['2026-11-06', '2026-11-05']]) {
    const response = await daily(harness, withDate(bad));
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.deepEqual((response.body as any).error.code, 'invalid_date');
  }

  const future = await daily(harness, withDate('2026-11-07'));
  assert.equal(future.status, 400);
  assert.equal((future.body as any).error.code, 'date_out_of_range');

  const oldestAllowed = await daily(harness, withDate('2026-10-30'));
  assert.equal(oldestAllowed.status, 200);
  assert.equal((oldestAllowed.body as any).date, '2026-10-30');

  const tooOld = await daily(harness, withDate('2026-10-29'));
  assert.equal(tooOld.status, 400);
  assert.equal((tooOld.body as any).error.code, 'date_out_of_range');

  const error = (() => {
    try {
      resolveDateKey('2026-11-07', NOW, 7);
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.code, 'date_out_of_range');
  assert.equal(error.status, 400);
});

test('date range never silently clamps and the lookback follows options', async () => {
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')] }),
    options: { maxLookbackDays: 2 },
  });
  assert.equal((await daily(harness, withDate('2026-11-04'))).status, 200);
  assert.equal((await daily(harness, withDate('2026-11-03'))).status, 400);
  assert.equal((await daily(harness)).status, 200);
});

// ---------------------------------------------------------------------------------------------
// Authentication, 401 policy, token rotation, not-configured, rate limiting, method policy
// ---------------------------------------------------------------------------------------------

test('authentication: missing and wrong tokens are both 401 with WWW-Authenticate', async () => {
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')] }) });
  const cases: Array<[string, Record<string, string | string[] | undefined>]> = [
    ['missing', {}],
    ['wrong', { authorization: 'Bearer totally-wrong-token' }],
    ['basic', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['bearer-without-value', { authorization: 'Bearer' }],
    ['bearer-extra', { authorization: `Bearer ${TOKEN} extra` }],
    ['empty', { authorization: '' }],
  ];
  for (const [label, headers] of cases) {
    const response = await harness.service.handleDailyStatus(apiRequest({ headers, query: {} }));
    assert.equal(response.status, 401, label);
    assert.equal((response.body as any).error.code, 'unauthorized');
    assert.equal(response.headers['WWW-Authenticate'], 'Bearer realm="bot-daily"');
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  // Missing and invalid are never 403: the policy is fixed to 401.
  assert.notEqual((await harness.service.handleDailyStatus(apiRequest({ headers: {} }))).status, 403);
});

test('health requires the same bearer token and returns read-only metadata', async () => {
  const harness = makeService({});
  const unauthorized = await harness.service.handleHealth(apiRequest({ headers: {} }));
  assert.equal(unauthorized.status, 401);
  const response = await harness.service.handleHealth(apiRequest());
  assert.equal(response.status, 200);
  const body = response.body as any;
  assert.equal(body.ok, true);
  assert.equal(body.service, 'maa-manager');
  assert.equal(body.apiVersion, 'v1');
  assert.equal(body.readOnly, true);
  assert.equal(body.timeZone, 'Asia/Tokyo');
  assert.equal(body.uptimeSeconds, 1234);
  assert.match(body.generatedAt, /\+09:00$/);
});

test('token rotation: every configured token is accepted and none is required to be the first', async () => {
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')] }),
    tokens: tokenSet(TOKEN, SECOND_TOKEN),
  });
  for (const token of [TOKEN, SECOND_TOKEN]) {
    const response = await harness.service.handleDailyStatus(apiRequest({ headers: { authorization: `Bearer ${token}` } }));
    assert.equal(response.status, 200, token);
  }
  assert.deepEqual(splitTokens('a, b\nc space'), ['a', 'b', 'c', 'space']);
  assert.deepEqual(verifyBearer(`bearer ${SECOND_TOKEN}`, [digestToken(TOKEN), digestToken(SECOND_TOKEN)]).ok, true);
  assert.equal(parseBearer('bearer abc'), 'abc');
  assert.equal(parseBearer('Basic abc'), null);
});

test('token loading: env wins, file fallback works, unreadable file fails closed without crashing or leaking', async () => {
  const fromEnv = await loadBotTokens(
    { BOT_DAILY_API_TOKEN: `${TOKEN},${SECOND_TOKEN}`, BOT_DAILY_API_TOKEN_FILE: '/does/not/matter' },
    async () => {
      throw new Error('must not read the file when env is set');
    },
    () => {},
  );
  assert.equal(fromEnv.configured, true);
  assert.equal(fromEnv.digests.length, 2);
  assert.equal(fromEnv.source, 'env');

  const fromFile = await loadBotTokens(
    { BOT_DAILY_API_TOKEN: '', BOT_DAILY_API_TOKEN_FILE: '/run/secrets/bot' },
    async () => `${TOKEN}\n${SECOND_TOKEN}\n`,
    () => {},
  );
  assert.equal(fromFile.configured, true);
  assert.equal(fromFile.digests.length, 2);
  assert.equal(fromFile.source, 'file');

  const logs: string[] = [];
  const unreadable = await loadBotTokens(
    { BOT_DAILY_API_TOKEN: '', BOT_DAILY_API_TOKEN_FILE: '/run/secrets/bot-daily-token' },
    async () => {
      throw Object.assign(new Error('EACCES: permission denied, open /run/secrets/bot-daily-token'), { code: 'EACCES' });
    },
    (line) => logs.push(line),
  );
  assert.equal(unreadable.configured, false);
  assert.deepEqual(unreadable.digests, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /EACCES/);
  assert.doesNotMatch(logs[0]!, /\/run\/secrets/);
  assert.doesNotMatch(logs[0]!, new RegExp(TOKEN));

  const none = await loadBotTokens({}, async () => '', () => {});
  assert.equal(none.configured, false);
  assert.equal(none.source, 'none');
});

test('not configured: both endpoints answer 503 with a fixed body', async () => {
  const harness = makeService({ tokens: tokenSet() });
  for (const response of [
    await harness.service.handleHealth(apiRequest()),
    await harness.service.handleDailyStatus(apiRequest()),
  ]) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: { code: 'not_configured', message: 'Bot API token is not configured' },
    });
  }
});

test('rate limiting: per-token window returns 429 with Retry-After and does not count failed auth', async () => {
  let clockMs = NOW_MS;
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')] }),
    options: { perTokenLimit: 2, globalLimit: 100 },
    clock: () => new Date(clockMs),
  });
  // Failed authentication never consumes the authenticated bucket.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await daily(harness, apiRequest({ headers: { authorization: 'Bearer wrong' } }))).status, 401);
  }
  assert.equal((await daily(harness)).status, 200);
  assert.equal((await daily(harness)).status, 200);
  const limited = await daily(harness);
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: { code: 'rate_limited', message: 'Too many requests' } });
  assert.ok(Number(limited.headers['Retry-After']) >= 1);
  // Next fixed window: allowed again.
  clockMs += 60_000;
  assert.equal((await daily(harness)).status, 200);
});

test('rate limiting: global cap applies across tokens', async () => {
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')] }),
    tokens: tokenSet(TOKEN, SECOND_TOKEN),
    options: { perTokenLimit: 100, globalLimit: 2 },
  });
  assert.equal((await daily(harness)).status, 200);
  assert.equal((await daily(harness, apiRequest({ headers: { authorization: `Bearer ${SECOND_TOKEN}` } }))).status, 200);
  const limited = await daily(harness);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers['Retry-After']);
});

test('method policy: only GET and HEAD; anything else is 405 with Allow', async () => {
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')] }) });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await harness.service.handleDailyStatus(apiRequest({ method }));
    assert.equal(response.status, 405, method);
    assert.deepEqual(response.body, { error: { code: 'method_not_allowed', message: 'Only GET is allowed' } });
    assert.equal(response.headers.Allow, 'GET, HEAD');
  }
  for (const method of ['GET', 'HEAD', 'get', 'head']) {
    assert.equal((await harness.service.handleHealth(apiRequest({ method }))).status, 200, method);
  }
  // Method policy is evaluated before authentication/configuration.
  const unauthenticated = await harness.service.handleDailyStatus(apiRequest({ method: 'POST', headers: {} }));
  assert.equal(unauthenticated.status, 405);
  const notConfigured = makeService({ tokens: tokenSet() });
  assert.equal((await notConfigured.service.handleDailyStatus(apiRequest({ method: 'POST' }))).status, 405);
});

// ---------------------------------------------------------------------------------------------
// HTTP transport: headers, no CORS, HEAD, status codes
// ---------------------------------------------------------------------------------------------

test('HTTP transport: no CORS headers, no-store headers, HEAD without a body', async () => {
  const harness = makeService({ repository: new FakeRepository({ presets: [makePreset('preset-a')] }) });
  await withHttpServer(harness.service, async (base) => {
    const get = await fetch(`${base}/api/v1/public/daily-status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(get.headers.get('pragma'), 'no-cache');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(get.headers.get('access-control-allow-origin'), null);
    assert.equal(get.headers.get('access-control-allow-credentials'), null);
    const body = await get.json();
    assert.equal(body.date, '2026-11-06');

    const unauthorized = await fetch(`${base}/api/v1/public/health`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer realm="bot-daily"');
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), null);

    const head = await fetch(`${base}/api/v1/public/health`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('cache-control'), 'no-store');

    const wrongMethod = await fetch(`${base}/api/v1/public/health`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(await wrongMethod.json(), {
      error: { code: 'method_not_allowed', message: 'Only GET is allowed' },
    });
    assert.equal(wrongMethod.headers.get('access-control-allow-origin'), null);
  });
});

// ---------------------------------------------------------------------------------------------
// Sensitive-field leak scan and 500 mapping
// ---------------------------------------------------------------------------------------------

test('no sensitive fields leak: token, account_name, snapshot, paths, DATABASE_URL', async () => {
  const rawPreset = JSON.stringify({
    name: 'Daily',
    tasks: [{ type: 'StartUp', params: { account_name: 'player-login-name' } }],
  });
  const preset: PresetRecord = {
    task: 'preset-a',
    displayName: 'Daily preset',
    raw: rawPreset,
    unreadable: false,
  };
  const runs = [
    makeRun({
      id: 'r-leaky',
      task: 'preset-a',
      status: 'failed',
      start: '2026-11-06T09:00:00+09:00',
      reason:
        'TaskChainError at D:\\app\\data\\manager.db; account_name=player-login-name; snapshot={"tasks":[]}; DATABASE_URL=file:/data/manager.db; token=' +
        TOKEN,
    }),
  ];
  const harness = makeService({ repository: new FakeRepository({ presets: [preset], runs }) });
  const response = await harness.service.handleDailyStatus(apiRequest());
  const serialized = JSON.stringify(response.body);
  for (const forbidden of [TOKEN, 'account_name', 'snapshot', 'DATABASE_URL', 'player-login-name', '/data/', '\\']) {
    assert.equal(serialized.includes(forbidden), false, `response must not contain ${JSON.stringify(forbidden)}`);
  }
  const body = response.body as any;
  assert.equal(body.presets[0].accountSwitchConfigured, true);
  assert.equal(body.presets[0].identityConfirmation, 'unavailable');
  assert.equal(body.presets[0].runs.items[0].reason.includes('[redacted]'), true);
  assert.equal(body.presets[0].runs.items[0].reason.includes('[path]'), true);
  assert.equal(sanitizeText('普通诊断信息') !== null, true);
  assert.equal(sanitizeText('   '), null);
});

test('unexpected errors map to a fixed 500 without leaking the error message', async () => {
  const logs: string[] = [];
  const harness = makeService({
    repository: new FakeRepository({ fail: new Error('secret /data/manager.db SQLITE_BUSY snapshot') }),
    logs,
  });
  const response = await harness.service.handleDailyStatus(apiRequest());
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: { code: 'internal_error', message: 'Internal error' } });
  const serialized = JSON.stringify(response.body);
  for (const forbidden of ['secret', '/data/', 'SQLITE_BUSY', 'snapshot']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /internal error/);
  assert.doesNotMatch(logs[0]!, /secret|\/data\/|SQLITE_BUSY/);
});

// ---------------------------------------------------------------------------------------------
// Read-only guarantees
// ---------------------------------------------------------------------------------------------

test('read-only: the service only calls the repository read port and never mutates', async () => {
  const harness = makeService({
    repository: new FakeRepository({ presets: [makePreset('preset-a')], schedules: [], runs: [] }),
  });
  // The fake exposes exactly one method; there is no write method for the service to call.
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(harness.repository)).filter(
    (name) => typeof (harness.repository as any)[name] === 'function',
  );
  assert.deepEqual(methods.sort(), ['constructor', 'readSnapshot']);
  for (let i = 0; i < 3; i += 1) assert.equal((await daily(harness)).status, 200);
  assert.equal(harness.repository.reads.length, 3);
  for (const read of harness.repository.reads) {
    assert.equal(read.window.dateKey, '2026-11-06');
    assert.equal(read.takeCap, BOT_API_DEFAULTS.takeCap);
  }
});

test('read-only: a real temporary SQLite database is unchanged after a read batch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-bot-api-db-'));
  const dbFile = path.join(dir, 'probe.db').replace(/\\/g, '/');
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
  const presetSource: PresetSource = {
    list: async () => [
      { name: 'preset-a', editable: true, displayName: 'Preset A' },
      { name: 'preset-b', editable: true, displayName: 'Preset B' },
      { name: 'legacy.yaml', editable: false, displayName: 'legacy' },
    ],
    read: async (name: string) => ({
      raw: JSON.stringify({ name, tasks: [{ type: 'Fight', params: { stage: 'LS-6' } }] }),
      displayName: name,
    }),
  };
  try {
    await prisma.$executeRawUnsafe(
      'CREATE TABLE Run (id TEXT PRIMARY KEY, task TEXT, hash TEXT, snapshot TEXT, status TEXT, source TEXT, scheduleId TEXT, occurrence TEXT UNIQUE, createdAt DATETIME, startedAt DATETIME, finishedAt DATETIME, exitCode INTEGER, reason TEXT, pid INTEGER, ownerId TEXT, managedTaskId TEXT, overrides TEXT)',
    );
    await prisma.$executeRawUnsafe(
      'CREATE TABLE Schedule (id TEXT PRIMARY KEY, name TEXT, task TEXT, type TEXT, expression TEXT, enabled BOOLEAN, nextAt DATETIME, createdAt DATETIME)',
    );
    await prisma.run.create({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        task: 'preset-a',
        hash: 'h1',
        snapshot: '{"tasks":[]}',
        status: 'success',
        source: 'schedule',
        scheduleId: 's-ai',
        occurrence: `s-ai:${new Date('2026-11-06T06:00:00+09:00').toISOString()}`,
        createdAt: new Date('2026-11-06T06:00:00+09:00'),
        startedAt: new Date('2026-11-06T06:00:01+09:00'),
        finishedAt: new Date('2026-11-06T06:20:00+09:00'),
        exitCode: 0,
        reason: null,
      },
    });
    await prisma.run.create({
      data: {
        id: '22222222-2222-4222-8222-222222222222',
        task: 'preset-b',
        hash: 'h2',
        snapshot: '{"tasks":[]}',
        status: 'failed',
        source: 'manual',
        createdAt: new Date('2026-11-06T09:00:00+09:00'),
        startedAt: new Date('2026-11-06T09:00:01+09:00'),
        finishedAt: new Date('2026-11-06T09:02:00+09:00'),
        exitCode: 1,
        reason: 'failed',
      },
    });
    await prisma.schedule.create({
      data: {
        id: 's-ai',
        name: 'Daily 06:00',
        task: 'preset-a',
        type: 'daily',
        expression: '06:00',
        enabled: true,
        nextAt: new Date('2026-11-06T06:00:00+09:00'),
        createdAt: new Date('2026-11-01T00:00:00+09:00'),
      },
    });

    const digestOf = async (): Promise<{ runs: number; schedules: number; digest: string }> => {
      const runs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM Run ORDER BY id');
      const schedules = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM Schedule ORDER BY id',
      );
      return {
        runs: runs.length,
        schedules: schedules.length,
        digest: createHash('sha256').update(JSON.stringify({ runs, schedules })).digest('hex'),
      };
    };
    const before = await digestOf();

    const repository = new PrismaDailyStatusRepository(prisma, presetSource, () => NOW);
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionCalls = 0;
    (prisma as any).$transaction = (...args: any[]) => {
      transactionCalls += 1;
      return (originalTransaction as any)(...args);
    };
    const service = new PublicApiService({
      repository,
      engine: { read: async () => IDLE_ENGINE },
      tokens: tokenSet(TOKEN),
      options: BOT_API_DEFAULTS,
      now: () => NOW,
      uptimeSeconds: () => 1,
      logger: () => {},
    });
    const response = await service.handleDailyStatus(apiRequest());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(transactionCalls, 1, 'schedule+run reads must use one $transaction batch');
    const body = response.body as any;
    assert.deepEqual(body.presets.map((preset: any) => preset.task), ['preset-a', 'preset-b']);
    assert.equal(body.presets[0].runs.items[0].id, '11111111-1111-4111-8111-111111111111');
    assert.equal(body.presets[0].runs.items[0].outcome, 'success');
    assert.equal(body.presets[0].plan[0].state, 'executed');
    assert.equal(body.presets[1].runs.items[0].outcome, 'failed');

    const after = await digestOf();
    assert.deepEqual(after, before, 'the read-only API must not change the database');
  } finally {
    await prisma.$disconnect().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

test('environment options are bounded and defaulted', () => {
  assert.deepEqual(botApiOptions({}), BOT_API_DEFAULTS);
  assert.equal(botApiOptions({ BOT_DAILY_MAX_LOOKBACK_DAYS: '14' }).maxLookbackDays, 14);
  assert.equal(botApiOptions({ BOT_DAILY_MAX_LOOKBACK_DAYS: '-1' }).maxLookbackDays, 0);
  assert.equal(botApiOptions({ BOT_DAILY_MAX_LOOKBACK_DAYS: '500' }).maxLookbackDays, 31);
  assert.equal(botApiOptions({ BOT_DAILY_RATE_LIMIT_PER_MINUTE: 'abc' }).perTokenLimit, 60);
  assert.equal(botApiOptions({ BOT_DAILY_MAX_ROWS: '999999' }).takeCap, 50_000);
  assert.equal(botApiOptions({ BOT_DAILY_STALE_AFTER_SECONDS: '60' }).staleAfterSeconds, 60);
});

test('composition root loads tokens once and fails closed without a token', async () => {
  const { createPublicApiService } = await import('../src/public-api/wiring');
  const store: any = { db: {} };
  const engine: any = { paused: false, health: { adb: true, android: true, maa: true }, current: undefined, control: { held: false } };
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    const enabled = await createPublicApiService(store, engine, { BOT_DAILY_API_TOKEN: TOKEN });
    assert.equal((await enabled.handleHealth(apiRequest())).status, 200);
    const disabled = await createPublicApiService(store, engine, {});
    const notConfigured = await disabled.handleHealth(apiRequest());
    assert.equal(notConfigured.status, 503);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-bot-token-'));
    try {
      const tokenFile = path.join(dir, 'token');
      await fs.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
      const fromFile = await createPublicApiService(store, engine, { BOT_DAILY_API_TOKEN_FILE: tokenFile });
      assert.equal((await fromFile.handleHealth(apiRequest())).status, 200);
      // The bad token is rejected even though the file loaded.
      assert.equal(
        (await fromFile.handleHealth(apiRequest({ headers: { authorization: 'Bearer nope' } }))).status,
        401,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } finally {
    console.error = originalError;
  }
  const serialized = logs.join('\n');
  assert.match(serialized, /bot-daily-api/);
  assert.equal(serialized.includes(TOKEN), false, 'startup diagnostics must never log the token');
  assert.equal(serialized.includes('player'), false);
});

test('builder never mutates its input records', () => {
  const preset = makePreset('preset-a');
  const schedule = makeSchedule({ id: 's-06', task: 'preset-a', expression: '06:00' });
  const run = makeRun({ id: 'r1', task: 'preset-a', start: '2026-11-06T09:00:00+09:00' });
  const input: DailyStatusInput = {
    now: NOW,
    date: '2026-11-06',
    presets: [preset],
    schedules: [schedule],
    runs: [run],
    engine: IDLE_ENGINE,
    databaseReadAt: NOW,
    truncated: false,
    options: { maxLookbackDays: 7, staleAfterSeconds: 300, takeCap: 5000 },
  };
  const snapshot = JSON.stringify({
    presets: input.presets,
    schedules: input.schedules,
    runs: input.runs,
    engine: input.engine,
  });
  buildDailyStatus(input);
  assert.equal(
    JSON.stringify({ presets: input.presets, schedules: input.schedules, runs: input.runs, engine: input.engine }),
    snapshot,
  );
});

// ---------------------------------------------------------------------------------------------
// Helpers used by a couple of assertions above
// ---------------------------------------------------------------------------------------------

test('jst helpers round-trip calendar keys', () => {
  assert.equal(jstDateKey(new Date('2026-11-05T15:00:00.000Z')), '2026-11-06');
  assert.equal(formatJst(new Date('2026-11-05T15:00:00.000Z')), '2026-11-06T00:00:00.000+09:00');
  assert.equal(formatJst(null), null);
  assert.equal(jstDateKey(new Date('2026-12-31T14:59:59.999Z')), '2026-12-31');
  assert.equal(jstDateKey(new Date('2026-12-31T15:00:00.000Z')), '2027-01-01');
});
