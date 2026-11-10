// Mall once-a-day: record the game date on which a Mall task actually visited friends / fought
// OF-1, like MaaWpfGui v6.21.4 AsstProxy.ProcSubTaskCompleted (taskchain "Mall", ProcessTask
// "VisitLimited"/"VisitNextBlack" → VisitFriendsLastTime, "StageDrops-Stars-3" → CreditFightLastTime).
//
// maa-cli v0.7.8 never logs SubTaskCompleted; the closest observable callback is SubTaskStart of the
// same ProcessTask, which it logs only at TRACE ("UnknownSubTaskStart: {json}", needs -vvv). Runs
// that need it are started with -vvv and their stderr goes through CallbackLogFilter, which extracts
// the markers and drops DEBUG/TRACE records so the stored run log equals a -v log.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import type {MallHistory} from './maa-model';

const RECORD = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (TRACE|DEBUG|INFO |WARN |ERROR)\] /;
const ANSI = /\x1b\[[0-9;]*m/g;
export const VISIT_TASKS = ['VisitLimited', 'VisitNextBlack'];
export const CREDIT_FIGHT_TASKS = ['StageDrops-Stars-3'];

export interface MallMarker { ordinal: number; kind: 'visitFriends' | 'creditFight'; }

/** Line-based filter for maa-cli stderr in -vvv runs. */
export class CallbackLogFilter {
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private level: string | null = null;
  private block: string[] = [];
  /** Index of the current Mall task chain (one per "Mall Start"), -1 before the first. */
  private ordinal = -1;
  readonly markers: MallMarker[] = [];

  feed(chunk: Buffer): string {
    const lines = (this.partial + this.decoder.write(chunk)).split('\n');
    this.partial = lines.pop() ?? '';
    return lines.map(line => this.line(line + '\n')).join('');
  }

  flush(): string {
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    const out = rest ? this.line(rest) : '';
    return out + this.closeBlock();
  }

  private depth = 0;
  private inString = false;
  private escaped = false;

  /** Bracket depth of the pretty JSON in a DEBUG/TRACE message, ignoring brackets inside strings. */
  private scan(text: string) {
    for (const ch of text) {
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
      } else if (ch === '"') this.inString = true;
      else if (ch === '{' || ch === '[') this.depth++;
      else if (ch === '}' || ch === ']') this.depth--;
    }
  }

  private line(raw: string): string {
    const plain = raw.replace(ANSI, '');
    const record = RECORD.exec(plain);
    if (record) {
      const closed = this.closeBlock();
      this.level = record[1].trim();
      if (this.level === 'INFO' && /\]\s+Mall Start\s*$/.test(plain)) this.ordinal++;
      if (this.level === 'TRACE' || this.level === 'DEBUG') {
        const message = plain.slice(record[0].length);
        this.block = [message];
        this.depth = 0; this.inString = false; this.escaped = false;
        this.scan(message);
        if (this.depth <= 0) return closed + this.endBlock();
        return closed;
      }
      return closed + raw;
    }
    // Continuation of a DEBUG/TRACE record: only while its JSON is still open. Any other line
    // (e.g. the account-identity notes the sequence prints without a prefix) is kept.
    if ((this.level === 'TRACE' || this.level === 'DEBUG') && this.depth > 0) {
      this.block.push(plain);
      this.scan(plain);
      if (this.depth <= 0) return this.endBlock();
      return '';
    }
    return raw;
  }

  /** Finish a DEBUG/TRACE record: later unprefixed lines no longer belong to it. */
  private endBlock(): string {
    const out = this.closeBlock();
    this.level = 'END';
    return out;
  }

  private closeBlock(): string {
    if (this.level === 'TRACE' && this.block.length) {
      const text = this.block.join('');
      const start = text.indexOf('{');
      if (text.startsWith('UnknownSubTaskStart:') && start >= 0) {
        try {
          const message = JSON.parse(text.slice(start));
          const task = message?.details?.task;
          if (message?.taskchain === 'Mall' && message?.subtask === 'ProcessTask' && this.ordinal >= 0) {
            if (VISIT_TASKS.includes(task)) this.markers.push({ordinal: this.ordinal, kind: 'visitFriends'});
            if (CREDIT_FIGHT_TASKS.includes(task)) this.markers.push({ordinal: this.ordinal, kind: 'creditFight'});
          }
        } catch { /* not a callback dump */ }
      }
    }
    this.block = [];
    return '';
  }
}

/** Persisted per-task state, keyed like compilePreset's stateKey (`<preset>#<index>#Mall`). */
export async function recordMallHistory(file: string, updates: Record<string, Partial<MallHistory>>): Promise<void> {
  if (!Object.keys(updates).length) return;
  const directory = path.dirname(file);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe state directory');
  let current: Record<string, MallHistory> = {};
  try {
    const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (stat.isFile() && stat.size <= 1024 * 1024) current = JSON.parse(await handle.readFile('utf8')) ?? {};
    } finally { await handle.close(); }
  } catch { current = {}; }
  for (const [key, value] of Object.entries(updates)) current[key] = {...(current[key] ?? {}), ...value};
  const temp = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(current, null, 1)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, {force: true}); }
}
