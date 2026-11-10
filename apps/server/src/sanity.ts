// The sanity-drain stage, remembered across runs.
//
// Why this exists: MAA's `stage: ""` means "current/last battle", and MAA reads the game's
// own 上次作战 entry for it (the log shows it clicking 「前往上一次作战」). A real
// annihilation battle overwrites that entry with the annihilation map, after which MAA
// applies its weekly-orundum cap check and stops the drain after a single battle — and it
// stays that way, because the drain's own battle keeps the entry poisoned. Naming the stage
// explicitly is therefore the only reliable way to spend all sanity; remembering it here is
// what keeps that explicit name from needing manual maintenance as event stages rotate.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const STAGE = /^[A-Za-z0-9][A-Za-z0-9@_-]{0,23}$/;

/**
 * A usable MAA stage code. Deliberately ASCII-only: annihilation maps are named in CJK
 * (拉特兰, 切尔诺伯格, …), which is exactly what keeps one from being learned as a
 * sanity stage.
 */
export function isStageCode(value: unknown): value is string {
  return typeof value === 'string' && STAGE.test(value) && (/[A-Za-z]/.test(value) || value.includes('-'));
}

/** A Fight with an empty stage means "the remembered sanity stage" in this project. */
export function usesSanityStage(doc: any): boolean {
  return Array.isArray(doc?.tasks) &&
    doc.tasks.some((task: any) => task?.type === 'Fight' && task?.params?.stage === '');
}

/** Only the explicit unlimited sentinel qualifies; missing defaults stay outside retry policy. */
export function isUnlimitedDrain(task: any): boolean { return task?.params?.times === 2147483647; }

/** Conservative selection: unresolved templates or resource budgets cannot be replayed safely. */
export function drainTasks(doc: any): any[] {
  if (!Array.isArray(doc?.tasks)) return [];
  const fights = doc.tasks.filter((task: any) => task?.type === 'Fight');
  const markers = fights.filter((task: any) => task?.params?.stage === '' && isUnlimitedDrain(task));
  if (markers.length !== 1) return [];
  const task = markers[0], p = task.params;
  // The aggregate log's last sanity observation must belong to this Fight.
  if (fights.at(-1) !== task || !isUnlimitedDrain(task) || task.enabled === false || ('enable' in p && p.enable !== true) ||
      'condition' in task || 'variants' in task || 'strategy' in task) return [];
  for (const key of ['medicine', 'stone', 'medicine_expire_days', 'expiring_medicine']) {
    if (key in p && p[key] !== 0) return [];
  }
  if ('drops' in p && (!p.drops || typeof p.drops !== 'object' || Array.isArray(p.drops) || Object.keys(p.drops).length)) return [];
  if (Object.values(p).some(value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length)) return [];
  return [task];
}

/** Null means no safe retry, never the original full preset. Disable implicit CLI tasks. */
export function sanityRetryDocument(doc: any, stage: string): any | null {
  const tasks = drainTasks(doc);
  if (!isStageCode(stage) || !tasks.length) return null;
  return {...doc, startup: false, closedown: false,
    tasks: tasks.map((task: any) => ({...task, params: {...task.params, stage}}))};
}

/**
 * True when a finished run left sanity its own last mission did not consume — the fingerprint
 * of the drain that could not run, either because the annihilation weekly cap stopped it or
 * because it fought a stage that was not the one the operator meant.
 */
export function drainIncomplete(log: string): boolean {
  const text = String(log ?? '');
  if (/Annihilation weekly limit reached/.test(text)) return true;
  const missions = [...text.matchAll(/Mission started \((\d+) times, use (\d+) sanity\)/g)];
  const sanity = [...text.matchAll(/Current sanity: (\d+)\//g)];
  if (!missions.length || !sanity.length) return false;
  const cost = Number(missions[missions.length - 1][2]);
  const left = Number(sanity[sanity.length - 1][1]);
  return Number.isFinite(cost) && Number.isFinite(left) && cost > 0 && left >= cost;
}

/**
 * The stage a finished run actually fought, taken from maa-cli's own summary line
 * ("Fight LS-6 5 times"). The last valid occurrence wins.
 */
export function learnStage(log: string): string | null {
  const codes = [...String(log ?? '').matchAll(/\bFight\s+(\S+)\s+\d+\s+times\b/g)].map(match => match[1]);
  for (let index = codes.length - 1; index >= 0; index--) {
    if (isStageCode(codes[index])) return codes[index];
  }
  return null;
}

export interface SanityStage {stage: string | null; learnedAt: string | null;}
/** Injected so the engine stays testable without touching files. */
export interface SanityStagePort {
  get(): Promise<SanityStage>;
  learn(stage: string): Promise<void>;
}

export class FileSanityStageStore implements SanityStagePort {
  constructor(private file: string) {}
  async get(): Promise<SanityStage> {
    const empty = {stage: null, learnedAt: null};
    try {
      const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid sanity stage state');
        const value = JSON.parse(await handle.readFile('utf8'));
        return {stage: isStageCode(value?.stage) ? value.stage : null,
          learnedAt: typeof value?.learnedAt === 'string' ? value.learnedAt : null};
      } finally { await handle.close(); }
    } catch { return empty; }
  }
  async learn(stage: string): Promise<void> {
    if (!isStageCode(stage)) throw new Error('Invalid stage code');
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe state directory');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({stage, learnedAt: new Date().toISOString()})}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temp, this.file);
    } finally { await fs.rm(temp, {force: true}); }
  }
}
