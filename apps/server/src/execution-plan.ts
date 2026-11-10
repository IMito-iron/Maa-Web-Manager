import {BadRequestException} from '@nestjs/common';
import {analyzePresetAccount, normalizeExecutionDocument, type PresetAccountPlan} from './account-safety';

export interface ExecutionPlan {
  /** Documents handed to maa-cli, in order. The stored preset is never modified. */
  documents: any[];
  /** True when this preset is split into "switch account" then "the rest". */
  switching: boolean;
  /** True when the executed snapshot differs from the stored preset (implicit-StartUp suppression). */
  normalized: boolean;
  account: PresetAccountPlan;
}

/**
 * Split explicit account switching into an independently checked CLI invocation, and normalise the
 * only case where the stored preset would not mean what the operator expects: a disabled explicit
 * StartUp together with `"startup": true` makes maa-cli prepend an implicit StartUp (without
 * `account_name`), so the disable would silently still start the game. The snapshot turns that flag
 * off; the stored preset and all StartUp parameters stay untouched.
 *
 * Account presets are validated here (enqueue time) and additionally fail closed at run time:
 * see account-safety.ts and sequence.ts.
 */
export function executionPlan(raw: string): ExecutionPlan {
  const doc=JSON.parse(raw);
  const account=analyzePresetAccount(doc);
  if(account.block) throw new BadRequestException(account.block.message);
  if(!account.switchRequested) {
    const normalized=normalizeExecutionDocument(doc);
    return {documents:[normalized.document],switching:false,normalized:normalized.changed,account};
  }
  const first=doc.tasks[0];
  // The switch invocation carries only the StartUp task; the second document carries the rest with
  // no implicit startup/closedown so maa-cli cannot add account-less tasks around the switch.
  const documents=[{...doc,startup:false,closedown:false,tasks:[first]}];
  if(doc.tasks.length>1)documents.push({...doc,startup:false,tasks:doc.tasks.slice(1)});
  else documents[0].closedown=doc.closedown;
  return {documents,switching:true,normalized:false,account};
}
