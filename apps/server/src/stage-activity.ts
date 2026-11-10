// Fetches MAA API `gui/StageActivityV2.json` the way MaaWpfGui v6.21.4 does
// (Services/Web/MaaApiService.cs + Helper/ETagCache.cs): primary api.maa.plus, then api2.maa.plus,
// conditional requests with ETag / Last-Modified, and the last good cache kept on any failure.
// Refresh cadence follows TaskQueueViewModel: at start-up, and at game-day 00:00 / 12:00
// (04:00 / 16:00 server time). Bounded: HTTPS only, fixed path, timeout, size cap, atomic write.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const STAGE_ACTIVITY_API = 'gui/StageActivityV2.json';
export const DEFAULT_MAA_API_BASES = ['https://api.maa.plus/MaaAssistantArknights/api/', 'https://api2.maa.plus/MaaAssistantArknights/api/'];
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
/** Not in Windows (a desktop app is restarted often): an unattended server retries a failed fetch. */
const FAILURE_RETRY_MS = 3600000;

export interface StageActivityStatus {
  enabled: boolean;
  /** Last time a response (200 or 304) was received. */
  checkedAt: string | null;
  /** Last time new content was written. */
  updatedAt: string | null;
  source: string | null;
  error: string | null;
  nextAt: string | null;
}

interface Meta { etag?: string; lastModified?: string; base?: string; checkedAt?: string; updatedAt?: string; }

type FetchLike = (url: string, init: {headers: Record<string, string>; signal: AbortSignal}) => Promise<{status: number; headers: {get(name: string): string | null}; arrayBuffer(): Promise<ArrayBuffer>}>;

/** Parse `MAA_API_URLS`: comma separated https base URLs ending with "/", or "off". */
export function parseApiBases(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return DEFAULT_MAA_API_BASES;
  if (value.trim().toLowerCase() === 'off') return [];
  const bases = value.split(',').map(v => v.trim()).filter(Boolean);
  for (const base of bases) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !base.endsWith('/')) throw new Error(`Invalid MAA API base URL: ${base}`);
  }
  return bases;
}

/** Next game-day 00:00 or 12:00 boundary after `from` (UTC+8 game day starts 04:00 → 20:00Z, 08:00Z). */
export function nextBoundary(from: Date): Date {
  const hours = [8, 20]; // 16:00 and 04:00 CST in UTC
  const d = new Date(from.getTime());
  for (let i = 0; i < 3; i++) {
    for (const h of hours) {
      const c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, h, 0, 0);
      if (c > from.getTime()) return new Date(c);
    }
  }
  return new Date(from.getTime() + 12 * 3600000);
}

export class StageActivityFetcher {
  private meta: Meta = {};
  private error: string | null = null;
  private nextAt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly file: string, private readonly bases: string[],
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly clock: () => Date = () => new Date()) {}

  private get metaFile() { return `${this.file}.meta.json`; }

  status(): StageActivityStatus {
    return {enabled: this.bases.length > 0, checkedAt: this.meta.checkedAt ?? null, updatedAt: this.meta.updatedAt ?? null,
      source: this.meta.base ?? null, error: this.error, nextAt: this.bases.length && this.nextAt ? new Date(this.nextAt).toISOString() : null};
  }

  /** Called every engine tick; starts at most one refresh when due. Never throws. */
  maybeRefresh(): Promise<void> | null {
    if (!this.bases.length || this.running || this.clock().getTime() < this.nextAt) return null;
    this.running = this.refresh().finally(() => { this.running = null; });
    return this.running;
  }

  async refresh(): Promise<void> {
    const started = this.clock();
    await this.loadMeta();
    const hasCache = await fs.stat(this.file).then(s => s.isFile(), () => false);
    const errors: string[] = [];
    for (const base of this.bases) {
      try {
        const headers: Record<string, string> = {Accept: 'application/json'};
        // ETagCache: conditional headers only when a cache exists and it came from the same base.
        if (hasCache && this.meta.base === base) {
          if (this.meta.etag) headers['If-None-Match'] = this.meta.etag;
          if (this.meta.lastModified) headers['If-Modified-Since'] = this.meta.lastModified;
        }
        const response = await this.fetchImpl(base + STAGE_ACTIVITY_API, {headers, signal: AbortSignal.timeout(TIMEOUT_MS)});
        const now = this.clock().toISOString();
        if (response.status === 304 && hasCache) {
          this.meta = {...this.meta, checkedAt: now};
          await this.saveMeta();
          return this.done(started, null);
        }
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > MAX_BYTES) throw new Error('response too large');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_BYTES) throw new Error('response too large');
        const json = JSON.parse(buffer.toString('utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json) || !Object.values(json).some(v => v && typeof v === 'object' && 'sideStoryStage' in (v as object))) {
          throw new Error('unexpected StageActivityV2 shape');
        }
        await this.atomicWrite(this.file, buffer);
        this.meta = {etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined, base, checkedAt: now, updatedAt: now};
        await this.saveMeta();
        return this.done(started, null);
      } catch (e: any) {
        errors.push(`${new URL(base).host}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    // Every source failed: keep the last good cache (MaaApiService falls back to it as well).
    this.done(started, errors.join('; '));
  }

  private done(started: Date, error: string | null) {
    this.error = error;
    this.nextAt = error ? Math.min(nextBoundary(started).getTime(), started.getTime() + FAILURE_RETRY_MS) : nextBoundary(started).getTime();
  }

  private async loadMeta() {
    try { this.meta = JSON.parse(await fs.readFile(this.metaFile, 'utf8')) ?? {}; } catch { this.meta = {}; }
  }
  private async saveMeta() { await this.atomicWrite(this.metaFile, Buffer.from(JSON.stringify(this.meta))); }

  private async atomicWrite(file: string, data: Buffer) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, {recursive: true, mode: 0o755});
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe cache directory');
    const temp = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o644);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, {force: true}); }
  }
}
