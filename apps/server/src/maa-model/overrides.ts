// "This run only" values of the Windows tri-state check boxes (bool? = null), per task index.
// Windows: right-click / unsaved tick → null → treated as enabled for this LinkStart, then reset by
// ResetFightVariables / ResetRecruitVariables. Scheduled runs never carry them.
import {readGuis} from './preset';
import type {RunOverrides} from './types';

export const RUN_ONLY_FIELDS: Record<string, (keyof RunOverrides)[]> = {
  Fight: ['UseMedicine', 'UseStone', 'EnableTimesLimit', 'EnableTargetDrop'],
  Recruit: ['UseExpedited'],
};

export type RunOverridesByTask = Record<string, RunOverrides>;

/**
 * Validate a submitted overrides object against the preset it will run with. Only `true` values
 * for the run-only fields of Windows-mode Fight/Recruit tasks are accepted; empty → null.
 */
export function parseRunOverrides(input: unknown, presetDoc: unknown): RunOverridesByTask | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('overrides must be an object keyed by task index');
  const tasks: any[] = Array.isArray((presetDoc as any)?.tasks) ? (presetDoc as any).tasks : [];
  const guis = readGuis(presetDoc);
  const out: RunOverridesByTask = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^(0|[1-9]\d{0,3})$/.test(key) || Number(key) >= tasks.length) throw new Error(`overrides: unknown task index ${key}`);
    const index = Number(key), type = tasks[index]?.type, allowed = RUN_ONLY_FIELDS[type];
    if (!allowed || !guis[index]) throw new Error(`overrides: task ${index + 1} has no run-only options (Windows-mode Fight/Recruit only)`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`overrides: task ${index + 1} must be an object`);
    const picked: RunOverrides = {};
    for (const [field, flag] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.includes(field as keyof RunOverrides) || typeof flag !== 'boolean') throw new Error(`overrides: ${field} is not a run-only option of ${type}`);
      if (flag) picked[field as keyof RunOverrides] = true;
    }
    if (Object.keys(picked).length) out[key] = picked;
  }
  return Object.keys(out).length ? out : null;
}
