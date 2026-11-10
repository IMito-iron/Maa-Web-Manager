/**
 * Contracts for the read-only public Bot API.
 *
 * These types are intentionally free of Prisma/Nest/Express imports: the pure daily-status builder
 * and its tests only ever see plain records. The Prisma adapter in `repository.ts` is the single
 * place where storage is touched, and it can only read.
 */
import type { DayWindow } from './jst';
import type { AccountIdentityPolicy } from '../account-safety';

/** Run sources the engine writes today. Anything else is reported as `other`. */
export type RunSource = 'manual' | 'schedule' | 'sanity-retry' | 'other';

/** Normalised run outcome; `success_unconfirmed` is a success we must not over-claim. */
export type RunOutcome =
  | 'success'
  | 'success_unconfirmed'
  | 'queued'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'interrupted'
  | 'unknown';

export type CompletionConfidence = 'confirmed' | 'unconfirmed' | 'unavailable';

/** The `Run` row fields this API is allowed to read. `snapshot`, `hash` and `pid` are not read. */
export interface RunRecord {
  id: string;
  task: string;
  status: string;
  source: string;
  scheduleId: string | null;
  occurrence: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  reason: string | null;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  task: string;
  type: string;
  expression: string;
  enabled: boolean;
  nextAt: Date;
  createdAt: Date;
}

/**
 * One editable preset as read from the Store. `raw` is the preset JSON text; it is `null` when the
 * file exists in the directory listing but cannot be read (reported under dataQuality).
 */
export interface PresetRecord {
  task: string;
  displayName: string;
  raw: string | null;
  unreadable: boolean;
}

/** One consistent read of everything the daily status needs. */
export interface SnapshotRead {
  schedules: ScheduleRecord[];
  /** Day rows plus carried-in candidates; the pure builder decides the final assignment. */
  runs: RunRecord[];
  presets: PresetRecord[];
  /** True when any storage query hit its row cap (details are reported in dataQuality). */
  truncated: boolean;
  /** When the snapshot finished reading; echoed as `databaseReadAt`. */
  databaseReadAt: Date;
}

/** Read-only storage port. Implementing types must never expose a write path to the API layer. */
export interface PublicApiRepository {
  readSnapshot(window: DayWindow, takeCap: number): Promise<SnapshotRead>;
}

/** Read-only engine state. Only public fields are read; no engine method is invoked. */
export interface EngineState {
  queuePaused: boolean;
  queueBlocked: boolean;
  running: boolean;
  currentRunId: string | null;
  controlHeld: boolean;
  /** Explicit account identity policy in force (require-verified | warn-continue). */
  accountIdentityPolicy?: AccountIdentityPolicy;
}

export interface EngineStatePort {
  read(): Promise<EngineState>;
}

export interface BuildOptions {
  maxLookbackDays: number;
  staleAfterSeconds: number;
  takeCap: number;
}
