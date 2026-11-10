import {createReadStream, promises as fs} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type {IdentityProbe, IdentityStatus} from './account-safety';

/**
 * Identity evidence from MaaCore's own debug log (asst.log), read on the Manager host only.
 *
 * AccountSwitchTask (MaaCore v6.21.4) takes one of two paths:
 * - equal_current_account(): the account manager page already shows the target as the current
 *   account, so Core clicks 登录 with no selection. The game can only log in as what it displayed:
 *   this is the only path treated as `confirmed`.
 * - select_account(): Core clicks the target in the list, clicks 登录 and emits `AccountSwitch`.
 *   The event only says the clicks happened. Production logs recorded a run where it was emitted
 *   and the old account stayed logged in (upstream issue #17845), so this path is `switched`:
 *   the caller must re-enter the account manager page and read the current account again.
 *
 * Only the last AccountSwitchTask attempt counts, because the StartUp chain retries internally.
 * Account names are compared here and never logged or returned.
 */
const SWITCH_ENTER = 'asst::AccountSwitchTask::_run | enter';
const SELECT_ENTER = 'asst::AccountSwitchTask::select_account | enter';
const SWITCH_CLASS = '"class":"asst::AccountSwitchTask"';
const PROCEED = /\] Proceed \[\{ text: ([^,]*),/;
const SWITCHED_NAME = /"account_name":"([^"]*)"/;

export class SwitchEvidence {
  private attempted = false;
  private matchedCurrent = false;
  private selecting = false;
  private completed = false;
  private switchedTo: string | null = null;

  constructor(private readonly accountName: string) {}

  feed(line: string): void {
    if (line.includes(SWITCH_ENTER)) {
      this.attempted = true;
      this.matchedCurrent = this.selecting = this.completed = false;
      this.switchedTo = null;
      return;
    }
    if (!this.attempted) return;
    if (line.includes(SELECT_ENTER)) { this.selecting = true; return; }
    if (line.includes(SWITCH_CLASS)) {
      if (line.includes('SubTaskCompleted')) this.completed = true;
      else if (line.includes('SubTaskError')) this.completed = false;
      else if (line.includes('"what":"AccountSwitch"')) this.switchedTo = SWITCHED_NAME.exec(line)?.[1] ?? '';
      return;
    }
    if (!this.selecting && !this.completed) {
      const text = PROCEED.exec(line)?.[1];
      // Core's own OCR requirement is a substring match on the configured name.
      if (text !== undefined && text.includes(this.accountName)) this.matchedCurrent = true;
    }
  }

  status(): IdentityStatus {
    if (!this.attempted || !this.completed) return 'unavailable';
    if (this.switchedTo !== null) return this.switchedTo.includes(this.accountName) ? 'switched' : 'mismatch';
    return !this.selecting && this.matchedCurrent ? 'confirmed' : 'unavailable';
  }
}

/** Where maa-cli keeps Core's debug log. */
export function coreLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || path.join(env.HOME || '', '.local', 'state');
  return path.join(state, 'maa', 'debug', 'asst.log');
}

export class CoreLogIdentityProbe implements IdentityProbe {
  private offset: number | null = null;

  constructor(private readonly logFile: string) {}

  async begin(): Promise<void> {
    this.offset = await sizeOf(this.logFile) ?? 0;
  }

  /** Reads only the bytes Core wrote since begin(), following one rotation to asst.bak.log. */
  async confirm(target: {accountName: string}): Promise<IdentityStatus> {
    if (this.offset === null) return 'unavailable';
    const size = await sizeOf(this.logFile);
    if (size === null) return 'unavailable';
    const evidence = new SwitchEvidence(target.accountName);
    try {
      if (size < this.offset) {
        const backup = path.join(path.dirname(this.logFile), 'asst.bak.log');
        await feedFrom(backup, this.offset, evidence);
        await feedFrom(this.logFile, 0, evidence);
      } else {
        await feedFrom(this.logFile, this.offset, evidence);
      }
    } catch {
      return 'unavailable';
    }
    return evidence.status();
  }
}

async function sizeOf(file: string): Promise<number | null> {
  try { return (await fs.stat(file)).size; } catch { return null; }
}

async function feedFrom(file: string, start: number, evidence: SwitchEvidence): Promise<void> {
  const lines = readline.createInterface({input: createReadStream(file, {start, encoding: 'utf8'}), crlfDelay: Infinity});
  for await (const line of lines) evidence.feed(line);
}
