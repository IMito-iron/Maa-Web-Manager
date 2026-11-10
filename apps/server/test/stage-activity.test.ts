import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StageActivityFetcher, nextBoundary, parseApiBases, DEFAULT_MAA_API_BASES} from '../src/stage-activity';
import {StageCatalog, compileTask, defaultGui} from '../src/maa-model';

const sample = fs.readFile(path.join(__dirname, 'fixtures', 'StageActivityV2.2026-11-08.json'));
const reply = (status: number, body: Buffer | string = '', headers: Record<string, string> = {}) => ({
  status, headers: {get: (n: string) => headers[n.toLowerCase()] ?? null}, arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
});

test('base URLs: Windows defaults, off, https-only', () => {
  assert.deepEqual(parseApiBases(undefined), DEFAULT_MAA_API_BASES);
  assert.deepEqual(parseApiBases('off'), []);
  assert.throws(() => parseApiBases('http://api.maa.plus/x/'));
  assert.throws(() => parseApiBases('https://user:pw@api.maa.plus/x/'));
  assert.throws(() => parseApiBases('https://api.maa.plus/x'));
});

test('refresh cadence: game-day 00:00 and 12:00 (04:00 / 16:00 CST)', () => {
  assert.equal(nextBoundary(new Date('2026-11-09T03:00:00Z')).toISOString(), '2026-11-09T08:00:00.000Z');
  assert.equal(nextBoundary(new Date('2026-11-09T08:00:00Z')).toISOString(), '2026-11-09T20:00:00.000Z');
  assert.equal(nextBoundary(new Date('2026-11-09T21:00:00Z')).toISOString(), '2026-11-10T08:00:00.000Z');
});

test('fetcher: fallback to api2, ETag revalidation, cache kept on failure, shape and size checks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-stage-'));
  const file = path.join(dir, 'cache', 'StageActivityV2.json');
  const body = await sample;
  const calls: {url: string; headers: Record<string, string>}[] = [];
  let mode = 'primary-down';
  const fake = async (url: string, init: any) => {
    calls.push({url, headers: init.headers});
    if (mode === 'primary-down') return url.includes('//api.maa') ? reply(503) : reply(200, body, {etag: '"e1"', 'last-modified': 'Sun, 08 Nov 2026 11:05:14 GMT'});
    if (mode === 'not-modified') return init.headers['If-None-Match'] ? reply(304) : reply(200, body, {etag: '"e2"'});
    if (mode === 'garbage') return reply(200, '[1,2]');
    if (mode === 'huge') return reply(200, 'x', {'content-length': String(5 * 1024 * 1024)});
    throw new Error('network down');
  };
  let now = new Date('2026-11-09T03:00:00Z');
  const fetcher = new StageActivityFetcher(file, DEFAULT_MAA_API_BASES, fake as any, () => now);
  try {
    await fetcher.maybeRefresh();
    assert.deepEqual(calls.map(c => new URL(c.url).host), ['api.maa.plus', 'api2.maa.plus']);
    assert.deepEqual(await fs.readFile(file), body);
    assert.equal(fetcher.status().source, DEFAULT_MAA_API_BASES[1]);
    assert.equal(fetcher.status().nextAt, '2026-11-09T08:00:00.000Z');
    assert.equal(fetcher.maybeRefresh(), null, 'not due before the next boundary');

    now = new Date('2026-11-09T08:00:01Z'); mode = 'not-modified'; calls.length = 0;
    await fetcher.maybeRefresh();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['If-None-Match'], undefined, 'conditional headers only for the base that produced the cache');
    assert.equal(fetcher.status().source, DEFAULT_MAA_API_BASES[0], 'primary is back: its fresh copy replaces the api2 cache');
    now = new Date('2026-11-09T20:00:01Z'); calls.length = 0;
    const before = fetcher.status().updatedAt;
    await fetcher.maybeRefresh();
    assert.equal(calls[0].headers['If-None-Match'], '"e2"');
    assert.equal(fetcher.status().updatedAt, before, '304 keeps the cached content');
    assert.equal(fetcher.status().error, null);

    for (const m of ['garbage', 'huge', 'down']) {
      mode = m; now = new Date(now.getTime() + 13 * 3600000);
      await fetcher.maybeRefresh();
      assert.match(fetcher.status().error ?? '', /api2\.maa\.plus/, m);
      assert.deepEqual(await fs.readFile(file), body, `cache kept after ${m}`);
    }
    assert.equal(Date.parse(fetcher.status().nextAt!) - now.getTime() <= 3600000, true, 'failure retries within an hour');
    const off = new StageActivityFetcher(file, [], fake as any);
    assert.equal(off.maybeRefresh(), null);
    assert.equal(off.status().enabled, false);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('real StageActivityV2 data: activity stages are listed, open within their window, and drive Fight backups', async () => {
  const json = JSON.parse((await sample).toString('utf8'));
  const catalog = new StageCatalog('Official', json);
  const during = new Date('2026-11-09T06:00:00Z'); // TL (2026/11/01 12:00 – 11/22 03:59 CST) is open
  assert.equal(catalog.hasActivityData, true);
  assert.equal(catalog.isOpen('TL-8', 1, during), true);
  assert.equal(catalog.isOpen('AT-8', 1, during), false, 'SSReopen-AT ended 2026/09/01');
  const list = catalog.stageList(during, 1);
  assert.equal(list[0].value, '');
  assert.deepEqual(list.filter(s => s.activity).map(s => s.value), ['TL-9', 'TL-8', 'TL-7', 'TL-4']);
  assert.ok(list.some(s => s.value === 'LS-6' && !s.activity));
  const fight = compileTask({type: 'Fight', gui: {...defaultGui('Fight'), UseOptionalStage: true, StagePlan: ['AT-8', 'TL-8', 'LS-6']}, index: 0, client: 'Official',
    settings: {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false},
    ctx: {now: during, neutral: false, stages: catalog, localTimeZone: 'Asia/Tokyo'}, enabledFights: [], stateKey: ''}) as any;
  assert.equal(fight.params.stage, 'TL-8');
  const after = compileTask({type: 'Fight', gui: {...defaultGui('Fight'), StagePlan: ['XX-1']}, index: 0, client: 'Official',
    settings: {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false},
    ctx: {now: during, neutral: false, stages: catalog, localTimeZone: 'Asia/Tokyo'}, enabledFights: [], stateKey: ''}) as any;
  assert.equal(after.params.stage, '', 'StageResetMode=Current: a stage missing from known data resets to current/last');
});
