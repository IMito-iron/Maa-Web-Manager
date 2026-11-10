// Server adapters for the maa-model runtime ports (files, clocks, resource paths).
// All reads are bounded (size cap, O_NOFOLLOW, fixed roots); nothing here executes anything.
import fs from 'node:fs';
import path from 'node:path';
import {cfg} from './config';
import {buildOperatorIndex, clientOf, compilePreset, gameDayOfWeek, StageCatalog, type OperatorIndex, type RunOverridesByTask, type CompiledPreset, type InfrastPlan, type InfrastPlanRead, type MallHistory, type RuntimeContext} from './maa-model';

const LIMIT = 1024 * 1024;
const BATTLE_DATA_LIMIT = 32 * 1024 * 1024;

/** Read a regular file under one of `roots`; null when absent, too big, a symlink or outside. */
export function boundedRead(file: string, roots: string[], limit = LIMIT): {ok: true; text: string} | {ok: false; missing: boolean} {
  const resolved = path.resolve(file);
  if (!roots.some(root => resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep))) return {ok: false, missing: true};
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return {ok: false, missing: false};
    return {ok: true, text: fs.readFileSync(fd, 'utf8')};
  } catch (e: any) {
    return {ok: false, missing: e?.code === 'ENOENT'};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const builtinDir = () => path.join(cfg.maaData, 'resource', 'custom_infrast');
const infrastRoots = () => [path.join(cfg.maaConfig, 'infrast'), builtinDir()];

/** maa-cli normalize_task_params: a relative filename lives in `<config>/infrast/`. */
export const resolveInfrastFile = (filename: string) => path.isAbsolute(filename) ? filename : path.join(cfg.maaConfig, 'infrast', filename);

/** CustomInfrastConfig: `plans[i].period` is an optional list of ["HH:mm","HH:mm"]. */
export function parseInfrastPlans(text: string): InfrastPlan[] | null {
  try {
    const root = JSON.parse(text);
    if (!Array.isArray(root?.plans)) return null;
    return root.plans.map((plan: any, index: number) => ({
      index,
      period: Array.isArray(plan?.period) ? plan.period.filter((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'string')) : [],
    }));
  } catch { return null; }
}

function readInfrastPlans(filename: string): InfrastPlanRead {
  const read = boundedRead(resolveInfrastFile(filename), infrastRoots());
  if (!read.ok) return read;
  const plans = parseInfrastPlans(read.text);
  return plans ? {ok: true, plans} : {ok: false, missing: false};
}

function readJson(file: string, roots: string[]): any {
  const read = boundedRead(file, roots);
  if (!read.ok) return null;
  try { return JSON.parse(read.text); } catch { return null; }
}

/** Build the dispatch-time context for one preset. */
export function runtimeContext(rawPreset: string, now = new Date(), overrides: RunOverridesByTask | null = null): RuntimeContext {
  let client: ReturnType<typeof clientOf> = 'Official';
  try { client = clientOf(JSON.parse(rawPreset)?.client_type); } catch {}
  const stateRoot = path.join(cfg.data, 'state');
  const activity = readJson(cfg.stageActivity, [path.dirname(cfg.stageActivity)]);
  const history = readJson(cfg.mallHistory, [stateRoot]);
  return {
    now, neutral: false,
    stages: new StageCatalog(client, activity),
    localTimeZone: cfg.timeZone,
    infrastPlans: readInfrastPlans,
    builtinInfrastPath: file => /^[A-Za-z0-9_.-]+\.json$/.test(file) ? path.join(builtinDir(), file) : path.join(builtinDir(), '_invalid_'),
    overrides: index => overrides?.[String(index)],
    operatorName: name => operatorIndex()?.resolve(name),
    mallHistory: key => (history && typeof history === 'object' && history[key] && typeof history[key] === 'object' ? history[key] as MallHistory : {}),
  };
}

/** Editor stage list for a client: "" + activity stages that are open or will open + permanent. */
export function stageListFor(clientType?: string, now = new Date()) {
  const client = clientOf(clientType);
  const activity = readJson(cfg.stageActivity, [path.dirname(cfg.stageActivity)]);
  const catalog = new StageCatalog(client, activity);
  return {client, hasActivityData: catalog.hasActivityData, stages: catalog.stageList(now, gameDayOfWeek(now, client))};
}

/** Compile the stored preset text for execution. Throws on malformed JSON (parseTask runs first). */
export function compileForRun(rawPreset: string, name: string, now = new Date(), overrides: RunOverridesByTask | null = null): CompiledPreset {
  return compilePreset(JSON.parse(rawPreset), runtimeContext(rawPreset, now, overrides), name);
}

/** One line per task for the run log: what the Manager handed to maa-cli and why. */
export function compileReport(compiled: CompiledPreset): string {
  const lines = compiled.reports.map(r => {
    if (r.mode === 'raw') return `[Manager] #${r.index + 1} ${r.name} (${r.type}): raw params`;
    const res = r.result!;
    const notes = res.notes.length ? ` — ${res.notes.join('；')}` : '';
    if (res.kind === 'append') return `[Manager] #${r.index + 1} ${r.name} (${r.type}): ${JSON.stringify(res.params)}${notes}`;
    return `[Manager] #${r.index + 1} ${r.name} (${r.type}): ${res.kind === 'skip' ? '跳过' : '错误'} ${res.reason}${notes}`;
  });
  return lines.join('\n') + '\n';
}

/**
 * maa-cli resource directories in load order (config/asst.rs default_resource_base_dirs +
 * installer/resource.rs resource_dirs): later ones override earlier ones, so the last existing
 * battle_data.json is the one MaaCore uses. MAA_BATTLE_DATA_FILE overrides the search.
 */
export function battleDataCandidates(): string[] {
  if (cfg.battleData) return [cfg.battleData];
  return [path.join(cfg.maaData, 'resource', 'battle_data.json'), path.join(cfg.maaData, 'MaaResource', 'resource', 'battle_data.json')];
}

let operatorCache: {key: string; index: OperatorIndex} | null = null;
/** DataHelper name index over battle_data.json; cached until the file changes. Null when absent. */
export function operatorIndex(): OperatorIndex | null {
  const file = [...battleDataCandidates()].reverse().find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!file) return null;
  let key: string;
  try { const s = fs.statSync(file); key = `${file}:${s.size}:${s.mtimeMs}`; } catch { return null; }
  if (operatorCache?.key === key) return operatorCache.index;
  const read = boundedRead(file, [path.dirname(file)], BATTLE_DATA_LIMIT);
  if (!read.ok) return null;
  try { operatorCache = {key, index: buildOperatorIndex(JSON.parse(read.text))}; } catch { return null; }
  return operatorCache.index;
}
