// Preset v2 envelope. The stored file stays a valid maa-cli task file:
//   { client_type, startup, closedown, tasks: [{name,type,params,...}],
//     manager: { model, settings, tasks: [{type, gui, paramsHash} | null, ...] } }
// maa-cli rejects unknown keys inside a task (`TaskTemplate` is deny_unknown_fields), so per-task
// GUI configs live in the top-level `manager.tasks`, aligned by index. An entry is honoured only when
// its type matches and `paramsHash` equals the task's current params: a hand edit of `params`
// (raw JSON, an older Manager) silently turns that task back into raw mode instead of being lost.
import {clientOf} from './clients';
import {compileTask} from './compile';
import {normalizeGui, NEVER_SAVED} from './defaults';
import {StageCatalog} from './stages';
import {DEFAULT_SETTINGS, isGuiTaskType, type ClientType, type Gui, type GuiTaskType, type PresetSettings, type RuntimeContext, type TaskCompile} from './types';

export const MODEL_ID = 'maa-windows/v6.21.4';

/** Deterministic JSON with sorted object keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => (value as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** FNV-1a 32-bit over the stable JSON; only detects edits, not a security boundary. */
export function paramsHash(params: unknown): string {
  let h = 0x811c9dc5;
  const text = stableStringify(params ?? {});
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function readSettings(doc: any): PresetSettings {
  const s = object(doc?.manager?.settings) ? doc.manager.settings : {};
  return {
    StartGame: typeof s.StartGame === 'boolean' ? s.StartGame : DEFAULT_SETTINGS.StartGame,
    ReportToPenguin: s.ReportToPenguin === true,
    PenguinId: typeof s.PenguinId === 'string' ? s.PenguinId : '',
    ReportToYituliu: s.ReportToYituliu === true,
  };
}

/** GUI config per task index; undefined = raw mode. */
export function readGuis(doc: any): (Gui | undefined)[] {
  const tasks: any[] = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const entries: any[] = Array.isArray(doc?.manager?.tasks) ? doc.manager.tasks : [];
  return tasks.map((task, i) => {
    const entry = entries[i];
    if (!object(entry) || !object(entry.gui) || entry.type !== task?.type || !isGuiTaskType(task?.type)) return undefined;
    return entry.paramsHash === paramsHash(task.params ?? {}) ? entry.gui : undefined;
  });
}

/** True when a manager entry exists for this index but no longer matches (shown as a warning). */
export function staleGuis(doc: any): boolean[] {
  const entries: any[] = Array.isArray(doc?.manager?.tasks) ? doc.manager.tasks : [];
  const live = readGuis(doc);
  return (Array.isArray(doc?.tasks) ? doc.tasks : []).map((_: unknown, i: number) => object(entries[i]?.gui) && !live[i]);
}

/** Native maa-cli disable: a task whose variants can never be active is skipped by the CLI. */
export function taskInactive(task: any): boolean {
  const never = (c: any) => object(c) && c.type === 'Not' && object(c.condition) && c.condition.type === 'Always';
  const vs = task?.variants;
  if (!Array.isArray(vs) || vs.length === 0) return false;
  return vs.every((v: any) => object(v) && (never(v.condition) || (object(v.condition) && v.condition.type === 'Or' && Array.isArray(v.condition.conditions) && v.condition.conditions.length === 0)
    || (object(v.condition) && v.condition.type === 'And' && Array.isArray(v.condition.conditions) && v.condition.conditions.some(never))));
}

export const neutralContext = (client: ClientType): RuntimeContext => ({
  now: new Date(0), neutral: true, stages: new StageCatalog(client, null), localTimeZone: 'UTC',
});

export interface CompiledTaskReport { index: number; name: string; type: string; mode: 'gui' | 'raw'; result: TaskCompile | null; }
export interface CompiledPreset {
  /** maa-cli document with `manager` removed and GUI tasks replaced by their compiled params. */
  document: any;
  /** Original task index of each entry of `document.tasks`. */
  indexes: number[];
  reports: CompiledTaskReport[];
  errors: string[];
}

/**
 * Compile a whole preset. Raw tasks pass through unchanged. GUI tasks are compiled; a skipped one is
 * removed from the document, an error aborts the whole run (Windows LinkStart semantics).
 * Disabled tasks (never-active variants) are not compiled, as Windows `IsTaskEnable` skips them.
 */
export function compilePreset(doc: any, ctx: RuntimeContext, presetName = ''): CompiledPreset {
  const client = clientOf(doc?.client_type);
  const settings = readSettings(doc);
  const guis = readGuis(doc);
  const tasks: any[] = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const enabledFights = tasks.map((t, i) => ({t, g: guis[i]})).filter(({t, g}) => t?.type === 'Fight' && g && !taskInactive(t)).map(({g}) => g!);
  const reports: CompiledTaskReport[] = [];
  const errors: string[] = [];
  const out: any[] = [];
  const indexes: number[] = [];
  const push = (task: any, index: number) => { out.push(task); indexes.push(index); };
  tasks.forEach((task, index) => {
    const name = typeof task?.name === 'string' && task.name ? task.name : String(task?.type ?? '');
    const gui = guis[index];
    if (!gui) { push(task, index); reports.push({index, name, type: task?.type, mode: 'raw', result: null}); return; }
    if (taskInactive(task)) { push(task, index); reports.push({index, name, type: task.type, mode: 'gui', result: {kind: 'skip', reason: '任务已禁用', notes: []}}); return; }
    const result = compileTask({type: task.type as GuiTaskType, gui, index, client, settings, ctx, enabledFights, stateKey: `${presetName}#${index}#${task.type}`});
    reports.push({index, name, type: task.type, mode: 'gui', result});
    if (result.kind === 'append') {
      // Only params are replaced; user-authored maa-cli variants/conditions keep their meaning.
      push({...task, params: result.params}, index);
    } else if (result.kind === 'error') errors.push(`${name}: ${result.reason}`);
  });
  const {manager, ...envelope} = doc ?? {};
  return {document: {...envelope, tasks: out}, indexes, reports, errors};
}

/** Write the GUI state into the envelope: compiled neutral params + aligned manager entries. */
export function attachGuis(doc: any, guis: (Gui | undefined)[], settings: PresetSettings): any {
  const client = clientOf(doc?.client_type);
  const tasks: any[] = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const ctx = neutralContext(client);
  const draft = {...doc, manager: {model: MODEL_ID, settings, tasks: []}};
  const enabledFights = tasks.map((t, i) => ({t, g: guis[i]})).filter(({t, g}) => t?.type === 'Fight' && g && !taskInactive(t)).map(({g}) => g!);
  const entries: any[] = [];
  const nextTasks = tasks.map((task, index) => {
    const gui = guis[index];
    if (!gui || !isGuiTaskType(task?.type)) { entries.push(null); return task; }
    const saved = {...normalizeGui(task.type, gui)};
    for (const key of NEVER_SAVED[task.type as GuiTaskType] ?? []) delete saved[key];
    const result = compileTask({type: task.type, gui: saved, index, client, settings, ctx, enabledFights, stateKey: ''});
    // A neutral skip (e.g. SwitchTheme without themes) still needs runnable params for raw/rollback.
    const params = result.kind === 'append' ? result.params : (task.params ?? {});
    entries.push({type: task.type, gui: saved, paramsHash: paramsHash(params)});
    return {...task, params};
  });
  const hasGui = entries.some(Boolean);
  const {manager, ...rest} = draft;
  return hasGui ? {...rest, tasks: nextTasks, manager: {...manager, tasks: entries}} : {...rest, tasks: nextTasks};
}

/**
 * Mall tasks of a compiled run that use a once-a-day option, by run order of Mall task chains.
 * `null` when the order cannot be known (a raw Mall task with conditional variants), in which case
 * nothing is recorded rather than attributing a visit to the wrong task.
 */
export function mallOnceADayPlan(doc: any, compiled: CompiledPreset, presetName: string): {keys: (string | null)[]} | null {
  const guis = readGuis(doc);
  const keys: (string | null)[] = [];
  for (let i = 0; i < compiled.document.tasks.length; i++) {
    const task = compiled.document.tasks[i], index = compiled.indexes[i];
    if (task?.type !== 'Mall' || taskInactive(task)) continue;
    if (Array.isArray(task.variants) && task.variants.length) return null;
    const gui = guis[index];
    keys.push(gui && (gui.VisitFriendsOnceADay || gui.CreditFightOnceADay) ? `${presetName}#${index}#Mall` : null);
  }
  return keys.some(Boolean) ? {keys} : null;
}
