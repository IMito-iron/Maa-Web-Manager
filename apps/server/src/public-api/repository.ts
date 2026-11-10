/**
 * Prisma adapter for the public API's read-only storage port.
 *
 * The schedule and run rows are read in one `$transaction([...findMany])` batch so the two lists
 * describe the same database snapshot; preset files are read through the Store's existing bounded,
 * symlink-refusing reader. There is deliberately no create/update/delete path in this module.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  PresetRecord,
  PublicApiRepository,
  RunRecord,
  ScheduleRecord,
  SnapshotRead,
} from './contracts';
import type { DayWindow } from './jst';

/** The subset of the Store the adapter needs; keeps the adapter easy to fake in tests. */
export interface PresetSource {
  list(): Promise<Array<{ name: string; editable: boolean; displayName: string }>>;
  read(name: string): Promise<{ raw: string; displayName: string }>;
}

export class PrismaDailyStatusRepository implements PublicApiRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly presets: PresetSource,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async readSnapshot(window: DayWindow, takeCap: number): Promise<SnapshotRead> {
    const start = window.start;
    const end = window.end;
    // Day rows: effective start (startedAt ?? createdAt) inside [start, end).
    const dayWhere: Prisma.RunWhereInput = {
      OR: [
        { startedAt: { gte: start, lt: end } },
        { startedAt: null, createdAt: { gte: start, lt: end } },
      ],
    };
    // Carried-in candidates: effective start before the window, still open or finished inside it.
    const carriedWhere: Prisma.RunWhereInput = {
      AND: [
        {
          OR: [
            { startedAt: { lt: start } },
            { startedAt: null, createdAt: { lt: start } },
          ],
        },
        { OR: [{ finishedAt: null }, { finishedAt: { gte: start } }] },
      ],
    };
    const [schedules, dayRows, carriedRows] = await this.db.$transaction([
      this.db.schedule.findMany({
        orderBy: [{ nextAt: 'asc' }, { id: 'asc' }],
        take: takeCap,
      }),
      this.db.run.findMany({
        where: dayWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: takeCap,
      }),
      this.db.run.findMany({
        where: carriedWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: takeCap,
      }),
    ]);
    const databaseReadAt = this.clock();

    const presets = await this.readPresets();
    const truncated = schedules.length >= takeCap || dayRows.length >= takeCap || carriedRows.length >= takeCap;

    return {
      schedules: schedules.map(toScheduleRecord),
      runs: [...dayRows.map(toRunRecord), ...carriedRows.map(toRunRecord)],
      presets,
      truncated,
      databaseReadAt,
    };
  }

  private async readPresets(): Promise<PresetRecord[]> {
    const listed = (await this.presets.list())
      .filter((item) => item.editable)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const presets: PresetRecord[] = [];
    for (const item of listed) {
      try {
        const read = await this.presets.read(item.name);
        presets.push({
          task: item.name,
          displayName: read.displayName || item.displayName || item.name,
          raw: read.raw,
          unreadable: false,
        });
      } catch {
        // A preset that exists in the listing but cannot be read is reported, not fatal.
        presets.push({
          task: item.name,
          displayName: item.displayName || item.name,
          raw: null,
          unreadable: true,
        });
      }
    }
    return presets;
  }
}

interface RunRowLike {
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

interface ScheduleRowLike {
  id: string;
  name: string;
  task: string;
  type: string;
  expression: string;
  enabled: boolean;
  nextAt: Date;
  createdAt: Date;
}

function toRunRecord(row: RunRowLike): RunRecord {
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    source: row.source,
    scheduleId: row.scheduleId,
    occurrence: row.occurrence,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    reason: row.reason,
  };
}

function toScheduleRecord(row: ScheduleRowLike): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    type: row.type,
    expression: row.expression,
    enabled: row.enabled,
    nextAt: row.nextAt,
    createdAt: row.createdAt,
  };
}
