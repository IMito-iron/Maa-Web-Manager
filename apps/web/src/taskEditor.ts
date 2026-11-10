import type {FieldDef, PresetDoc, TaskEntry} from './taskSchema';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const never = () => ({type: 'Not', condition: {type: 'Always'}});
const isNever = (v: unknown) => object(v) && Object.keys(v).length === 2 && v.type === 'Not' && object(v.condition) && Object.keys(v.condition).length === 1 && v.condition.type === 'Always';
const emptyOr = (v: unknown) => object(v) && Object.keys(v).length === 2 && v.type === 'Or' && Array.isArray(v.conditions) && v.conditions.length === 0;
const wrapped = (v: unknown) => object(v) && Object.keys(v).length === 2 && v.type === 'And' && Array.isArray(v.conditions) && [1, 2].includes(v.conditions.length) && isNever(v.conditions[0]);

/** Native maa-cli conditions, not an ignored `enabled` property. No executable params change. */
export function taskDisabled(task: TaskEntry): boolean {
  const variants = task.variants;
  if ((!Array.isArray(variants) || variants.length === 0) && task.params.enable === false) return true;
  return Array.isArray(variants) && variants.length > 0 && variants.every(v => object(v) && (wrapped(v.condition) ||
    (variants.length === 1 && Object.keys(v).length === 1 && (isNever(v.condition) || emptyOr(v.condition)))));
}

/**
 * Why only maa-cli's native condition mechanism is used for the persisted enabled state:
 * TOP-LEVEL `"startup": true` makes maa-cli prepend an implicit StartUp (without `account_name`)
 * whenever no StartUp task is included in the execution document, and it also forces an included
 * StartUp's `start_game_enabled` to true. A task with a provably-never condition is skipped by the
 * CLI itself, so disabling is effective without deleting the task or its parameters; the Manager
 * additionally suppresses the preset-level flag in the execution snapshot (see account-safety.ts),
 * because the stored preset must not be rewritten.
 */
export function toggleBlock(doc: PresetDoc, task: TaskEntry): string {
  if (task.type === 'CloseDown' && doc.closedown) return '请先关闭预设的结束后关闭游戏，避免 CLI 生成隐式关闭任务';
  if (Object.hasOwn(task, 'variants') && (!Array.isArray(task.variants) || task.variants.some(v => !object(v)))) return '变体格式不支持可视化修改，请使用原始 JSON';
  return '';
}

/** True when this StartUp task names a game account, i.e. it asks to switch accounts. */
export function switchesAccount(task: TaskEntry): boolean {
  if (task.type !== 'StartUp') return false;
  const name = task.params.account_name;
  return typeof name === 'string' && name.trim() !== '';
}

/**
 * Execution notices for StartUp. These describe the backend contract, not a UI-only guard: the
 * Manager rejects a disabled account StartUp at enqueue time and never treats "StartUp Completed"
 * as evidence that the target account is logged in.
 */
export function startupNotices(doc: PresetDoc, task: TaskEntry, accountPolicy: 'require-verified' | 'warn-continue' = 'require-verified'): string[] {
  if (task.type !== 'StartUp') return [];
  const notices: string[] = [];
  const account = switchesAccount(task);
  if (taskDisabled(task)) {
    notices.push(doc.startup
      ? '已禁用 StartUp：执行时不会启动游戏客户端，也不会切换账号。Manager 会在执行快照中关闭预设级「自动启动游戏」，避免 maa-cli 隐式插入 StartUp；保存的原始配置与全部参数不变。'
      : '已禁用 StartUp：执行时不会启动游戏客户端，也不会切换账号；保存的原始配置与全部参数不变，重新启用即可无损恢复。');
    if (account) notices.push('StartUp 已禁用但仍保留账号名：保存不会被阻止，但执行会被后端拒绝，因为无法切换或确认目标账号。');
  } else if (account) {
    notices.push(accountPolicy === 'warn-continue'
      ? '此 StartUp 指定了账号。当前为账号身份兼容模式：开始唤醒完成后会继续执行，但无法验证当前登录账号；切换可能未生效、任务可能作用在旧账号上。这是显式配置的风险模式，不代表身份已验证。'
      : '此 StartUp 指定了账号。Manager 不会把「开始唤醒完成」当作身份已验证：StartUp 结束后若无法确认当前登录账号就是目标账号，后续账号专属任务将被阻止（当前 fail-closed）。');
  }
  return notices;
}

export function setTaskEnabled(doc: PresetDoc, index: number, enabled: boolean): PresetDoc {
  const task = doc.tasks[index];
  if (!task || taskDisabled(task) === !enabled) return doc;
  const reason = enabled ? '' : toggleBlock(doc, task);
  if (reason) throw new Error(reason);
  const next = {...task};
  if (enabled && (!Array.isArray(task.variants) || task.variants.length === 0) && task.params.enable === false) {
    next.params = {...task.params, enable: true};
    return {...doc, tasks: doc.tasks.map((v, i) => i === index ? next : v)};
  }
  if (!enabled) {
    if (!Object.hasOwn(task, 'variants')) next.variants = [{condition: never()}];
    else if (!(task.variants as any[]).length) next.variants = [{condition: {type: 'Or', conditions: []}}];
    else next.variants = (task.variants as any[]).map(v => ({...v, condition: {type: 'And', conditions: [never(), ...(Object.hasOwn(v, 'condition') ? [v.condition] : [])]}}));
  } else {
    const variants = task.variants as any[];
    if (variants.length === 1 && Object.keys(variants[0]).length === 1 && isNever(variants[0].condition)) delete next.variants;
    else if (variants.length === 1 && Object.keys(variants[0]).length === 1 && emptyOr(variants[0].condition)) next.variants = [];
    else next.variants = variants.map(v => {
      const restored = {...v};
      if (v.condition.conditions.length === 1) delete restored.condition;
      else restored.condition = v.condition.conditions[1];
      return restored;
    });
  }
  return {...doc, tasks: doc.tasks.map((v, i) => i === index ? next : v)};
}

export function duplicateTask(doc: PresetDoc, index: number, suffix = ' 副本'): PresetDoc {
  if (!doc.tasks[index]) return doc;
  const copy: TaskEntry = JSON.parse(JSON.stringify(doc.tasks[index]));
  copy.name = (copy.name || copy.type) + suffix;
  return {...doc, tasks: [...doc.tasks.slice(0, index + 1), copy, ...doc.tasks.slice(index + 1)]};
}

/** Incompatible/templated values must never be coerced by an ordinary input control. */
export function fieldEditable(field: FieldDef, value: unknown): boolean {
  if (value === undefined) return true;
  if (field.kind === 'multi-select' || field.kind === 'tags') return Array.isArray(value) && value.every(v => typeof v === 'string' || typeof v === 'number');
  if (field.kind === 'boolean') return typeof value === 'boolean';
  if (field.kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string' || (field.kind === 'select' && typeof value === 'number');
}

const basic: Record<string, string[]> = {
  StartUp: ['client_type', 'start_game_enabled', 'account_name'], Fight: ['stage', 'times', 'medicine', 'stone', 'medicine_expire_days'],
  Recruit: ['refresh', 'select', 'confirm', 'times'], Infrast: ['mode', 'facility', 'drones', 'dorm_trust_enabled'],
  Mall: ['shopping', 'buy_first', 'blacklist', 'force_shopping_if_credit_full'], Award: ['award', 'mail', 'recruit', 'orundum', 'mining'],
};
export const basicFields = (type: string, fields: FieldDef[]) => fields.filter(f => (basic[type] ?? fields.slice(0, 4).map(v => v.key)).includes(f.key));

export function runBlock(status: any, fresh: boolean, pending: boolean): string {
  if (!fresh || pending || typeof status?.queue?.paused !== 'boolean' || typeof status.queue.blocked !== 'boolean') return '运行状态未确认，请等待连接恢复';
  if (status.queue.paused) return '队列已暂停，不能运行';
  if (status.queue.blocked) return '执行环境受阻，不能运行';
  if (!status.android || !status.adb || !status.maa) return '设备或 MAA 未就绪，不能运行';
  return '';
}

/** Validate before parsing: a visual round-trip must never drop malformed rows/params. */
export function validateEditorRaw(raw: string): void {
  const doc = JSON.parse(raw);
  if (!object(doc) || !Array.isArray(doc.tasks) || !doc.tasks.length) throw new Error('任务列表不能为空，未保存');
  if (['name', 'client_type'].some(key => key in doc && typeof doc[key] !== 'string' && doc[key] !== null) ||
      ['startup', 'closedown'].some(key => key in doc && typeof doc[key] !== 'boolean')) throw new Error('预设字段格式无效，请在原始 JSON 中修正');
  if (doc.tasks.some((t: unknown) => !object(t) || typeof t.type !== 'string' || !t.type || (Object.hasOwn(t, 'name') && typeof t.name !== 'string') || (Object.hasOwn(t, 'params') && !object(t.params)))) {
    throw new Error('任务类型或参数格式无效，请在原始 JSON 中修正');
  }
}
