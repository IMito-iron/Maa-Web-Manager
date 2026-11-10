/**
 * Account identity safety for presets that name a game account.
 *
 * Why this module exists (upstream evidence: ACCOUNT_SWITCH_UPSTREAM_STATUS.md):
 * - MaaCore's StartUp task takes `account_name` as *input*; neither MaaCore nor maa-cli reports
 *   which account is actually logged in afterwards. `TaskChainCompleted`/`AllTasksCompleted`
 *   carry only taskchain/taskid/uuid, and the `AccountSwitch` sub-task message is undocumented and
 *   its `current_account` validation is still commented out in AccountSwitchTask.cpp.
 * - Upstream issue #17845 shows a switch that reported success while the old account stayed
 *   logged in, after which the *next* account's infrast plan ran on the old account. PR #18524 /
 *   #18538 (MaaResource only) are NOT part of MaaCore 6.18.0 that production runs; the first
 *   release containing them is v6.19.0.
 * - The login-page layout change (issue #18533) makes the account-manager template match fail
 *   (score 0.71185) on 6.18.0 resources.
 *
 * Therefore "StartUp Completed" is NOT treated as identity verification. A preset that requires
 * a specific account is fail-closed: the StartUp invocation may run (that is the switch attempt),
 * but its account-scoped tasks are only executed when the injected identity probe positively
 * confirms the target account. Production uses CoreLogIdentityProbe (core-log-identity-probe.ts).
 *
 * Native activity semantics mirror maa-cli v0.7.5 `TaskConfigTemplate::init`:
 * - a task with no `variants` is included unless `params.enable === false`;
 * - a task whose variants are all provably-never conditions is skipped entirely;
 * - any other variant set depends on the runtime clock and cannot be guaranteed here.
 * Top-level `"startup": true` makes maa-cli prepend an implicit StartUp (without `account_name`)
 * when no StartUp task is included; that is why disabling the explicit StartUp must also
 * suppress the preset-level flag in the execution snapshot.
 */

export type TaskState = 'active' | 'disabled' | 'conditional';
/**
 * `switched` means a switch was attempted but not yet proven: the coordinator must read the current
 * account again (sequence.ts). It never releases account-scoped tasks.
 */
export type IdentityStatus = 'confirmed' | 'switched' | 'mismatch' | 'unavailable';

/**
 * What to do when a StartUp completed but identity cannot be verified:
 * - `require-verified` (default): block the account-scoped tasks (fail-closed);
 * - `warn-continue`: an explicitly configured compatibility mode. The run continues, the risk is
 *   written to the run log/reason and shown in the console/API; identity is never claimed.
 * A clearly failed StartUp is blocked in both modes.
 */
export type AccountIdentityPolicy = 'require-verified' | 'warn-continue';

export function parseAccountIdentityPolicy(value: unknown): AccountIdentityPolicy {
  return value === 'warn-continue' ? 'warn-continue' : 'require-verified';
}

/** Reason prefixes stored on Run.reason; stable machine-readable codes for the UI/API. */
export const ACCOUNT_IDENTITY_UNVERIFIED = 'ACCOUNT_IDENTITY_UNVERIFIED';
export const ACCOUNT_IDENTITY_MISMATCH = 'ACCOUNT_IDENTITY_MISMATCH';
export const ACCOUNT_IDENTITY_UNVERIFIED_COMPAT = 'ACCOUNT_IDENTITY_UNVERIFIED_COMPAT';
export const ACCOUNT_STARTUP_DISABLED = 'ACCOUNT_STARTUP_DISABLED';
export const ACCOUNT_STARTUP_CONDITIONAL = 'ACCOUNT_STARTUP_CONDITIONAL';

export const ACCOUNT_IDENTITY_UNVERIFIED_REASON =
  '[ACCOUNT_IDENTITY_UNVERIFIED] 账号身份未验证：开始唤醒已结束，但 Core/CLI 没有提供"当前登录账号"的可验证证据；' +
  '为避免在错误账号上执行基建/刷图等账号专属任务，后续任务已被阻止（fail-closed）。';
export const ACCOUNT_IDENTITY_MISMATCH_REASON =
  '[ACCOUNT_IDENTITY_MISMATCH] 账号身份不一致：身份验证器未能确认当前登录账号就是预设目标账号；' +
  '为避免在错误账号上执行账号专属任务，后续任务已被阻止（fail-closed）。';
export const ACCOUNT_IDENTITY_UNVERIFIED_COMPAT_REASON =
  '[ACCOUNT_IDENTITY_UNVERIFIED_COMPAT] 账号身份兼容模式：开始唤醒已结束，但无法验证当前登录账号；' +
  '已按显式配置的兼容模式继续执行后续任务。风险：切换可能未生效，任务可能作用在旧账号上；本记录不代表身份已验证。';
export const ACCOUNT_STARTUP_DISABLED_REASON =
  '[ACCOUNT_STARTUP_DISABLED] 指定账号的预设要求首个 StartUp 保持启用：该 StartUp 已被禁用，无法切换或确认账号身份，禁止执行。';
export const ACCOUNT_STARTUP_CONDITIONAL_REASON =
  '[ACCOUNT_STARTUP_CONDITIONAL] 指定账号的预设要求首个 StartUp 无条件启用：该 StartUp 带有条件或变体，无法保证切换执行，禁止执行。';

export interface IdentityProbe {
  /** Called before each StartUp invocation so the probe only considers that invocation's evidence. */
  begin?(): Promise<void>;
  /** Confirm whether the named account is the account that is actually logged in. */
  confirm(target: { accountName: string }): Promise<IdentityStatus>;
}

/** A probe that reports "cannot determine", for callers with no evidence source. */
export class UnavailableIdentityProbe implements IdentityProbe {
  async confirm(): Promise<IdentityStatus> { return 'unavailable'; }
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A condition that can never be true: the project's native "disabled" marker. */
export function isNeverCondition(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.type === 'Not' && object(value.condition) && value.condition.type === 'Always') return true;
  return value.type === 'Or' && Array.isArray(value.conditions) && value.conditions.length === 0;
}

/** Native, conservative inclusion check for one task template. */
export function taskState(task: unknown): TaskState {
  if (!object(task)) return 'disabled';
  const variants = (task as any).variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    return object((task as any).params) && (task as any).params.enable === false ? 'disabled' : 'active';
  }
  if (variants.every((variant: unknown) => object(variant) && isNeverCondition((variant as any).condition ?? { type: 'Always' }))) return 'disabled';
  return 'conditional';
}

export interface AccountBlock { code: string; message: string; }
export interface PresetAccountPlan {
  /** True when the preset names a game account and therefore requires an identity decision. */
  switchRequested: boolean;
  /** The target account input, never a claim about the logged-in account. */
  accountName?: string;
  startupIndex: number;
  startupState: TaskState | 'none';
  /** Account-scoped tasks must not run until identity is positively confirmed. */
  identityRequired: boolean;
  /** Non-null when the preset cannot be executed at all. */
  block?: AccountBlock;
}

function containsAccount(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAccount);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, item]) => key === 'account_name'
    ? (typeof item === 'string' ? item.trim() !== '' : item !== null && item !== undefined)
    : containsAccount(item));
}

/**
 * Decide, from the stored preset document alone, whether account switching is requested and
 * whether the execution chain can honour it. Never claims identity; only states requirements.
 */
export function analyzePresetAccount(doc: unknown): PresetAccountPlan {
  const tasks = object(doc) && Array.isArray(doc.tasks) ? doc.tasks : [];
  const startupIndexes = tasks.map((task: any, index: number) => task?.type === 'StartUp' ? index : -1).filter((index: number) => index >= 0);
  const first = tasks[0] as any;
  const firstStartup = startupIndexes.length ? (tasks[startupIndexes[0]] as any) : undefined;
  const startupState: TaskState | 'none' = firstStartup ? taskState(firstStartup) : 'none';
  const requested = containsAccount(doc);
  const rawName = first?.type === 'StartUp' && typeof first?.params?.account_name === 'string' ? first.params.account_name.trim() : '';
  const base: PresetAccountPlan = {
    switchRequested: requested,
    accountName: rawName || undefined,
    startupIndex: startupIndexes.length ? startupIndexes[0] : -1,
    startupState,
    identityRequired: requested,
  };
  if (!requested) return base;
  const block: AccountBlock | undefined = (() => {
    if (startupIndexes.length === 0 || tasks[0]?.type !== 'StartUp') {
      return { code: ACCOUNT_STARTUP_CONDITIONAL, message: '指定账号时，首个任务必须是 StartUp（account_name）；不支持把账号放在其他任务或变体中，请拆分为独立预设。' };
    }
    if (startupIndexes.length > 1) {
      return { code: ACCOUNT_STARTUP_CONDITIONAL, message: '不支持多个 StartUp：指定账号的预设只能有一个 StartUp，请拆分为独立预设。' };
    }
    if (tasks.slice(1).some((task: any) => containsAccount(task))) {
      return { code: ACCOUNT_STARTUP_CONDITIONAL, message: '不支持条件切号：只有首个 StartUp 可以携带 account_name。' };
    }
    if (startupState === 'disabled') return { code: ACCOUNT_STARTUP_DISABLED, message: ACCOUNT_STARTUP_DISABLED_REASON };
    if (startupState === 'conditional' || Object.hasOwn(first ?? {}, 'condition') || (first as any)?.enabled === false) {
      return { code: ACCOUNT_STARTUP_CONDITIONAL, message: ACCOUNT_STARTUP_CONDITIONAL_REASON };
    }
    return undefined;
  })();
  return block ? { ...base, block } : base;
}

/**
 * Build the document that is actually executed, from the stored preset.
 *
 * Only one thing is ever changed: when the preset-level `startup` flag is true while every
 * explicit StartUp task is provably disabled, the flag is turned off so maa-cli cannot prepend
 * its implicit StartUp (which ignores `account_name`). Everything else, including the disabled
 * StartUp task with all of its parameters, is passed through verbatim. Presets without a disabled
 * StartUp task are returned unchanged (byte-for-byte identical value), which keeps ordinary
 * single-account presets on their existing execution path.
 */
export function normalizeExecutionDocument(doc: any): { document: any; changed: boolean } {
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const startups = tasks.filter((task: any) => task?.type === 'StartUp');
  const suppressed = doc?.startup === true && startups.length > 0 && startups.every((task: any) => taskState(task) === 'disabled');
  if (!suppressed) return { document: doc, changed: false };
  return { document: { ...doc, startup: false }, changed: true };
}

/**
 * The reason a switching run must stop after StartUp; null when it may continue.
 * `warn-continue` only relaxes the "completed but unverified" case; a mismatch still blocks.
 */
export function identityBlockReason(
  status: IdentityStatus,
  policy: AccountIdentityPolicy = 'require-verified',
): string | null {
  if (status === 'confirmed') return null;
  if (status === 'unavailable' && policy === 'warn-continue') return null;
  // `switched` is resolved by the coordinator; anything that still reaches here is unproven.
  return status === 'mismatch' ? ACCOUNT_IDENTITY_MISMATCH_REASON : ACCOUNT_IDENTITY_UNVERIFIED_REASON;
}

/** The note recorded on a successful run whose identity could not be verified (compat mode). */
export function identityPolicyNote(policy: AccountIdentityPolicy): string | null {
  return policy === 'warn-continue' ? ACCOUNT_IDENTITY_UNVERIFIED_COMPAT_REASON : null;
}

/** Map the switching coordinator's exit code to a stable reason; null for other codes. */
export function accountIdentityReason(switching: boolean, code: number | null | undefined): string | null {
  if (!switching) return null;
  if (code === 3) return ACCOUNT_IDENTITY_UNVERIFIED_REASON;
  if (code === 4) return ACCOUNT_IDENTITY_MISMATCH_REASON;
  return null;
}
