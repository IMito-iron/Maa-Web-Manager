/**
 * Application service for the public Bot API.
 *
 * Policy order (fixed by the contract): method -> configuration -> authentication -> rate limit ->
 * work. Responses are always JSON with `Cache-Control: no-store`, never CORS headers, and never any
 * internal detail: the only error bodies are fixed `{error:{code,message}}` objects.
 */
import type { BotApiOptions } from './options';
import type { EngineStatePort, PublicApiRepository } from './contracts';
import { buildDailyStatus, type DailyStatusResponse } from './daily-status';
import { errorBody, PublicApiError } from './errors';
import { formatJst, dayWindow, resolveDateKey } from './jst';
import { RateLimiter } from './limiter';
import type { TokenLoadResult } from './tokens';
import { verifyBearer } from './tokens';

export interface ApiRequest {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface PublicApiServiceDeps {
  repository: PublicApiRepository;
  engine: EngineStatePort;
  tokens: TokenLoadResult;
  options: BotApiOptions;
  /** Injected clock: tests never sleep and never depend on the machine clock. */
  now: () => Date;
  uptimeSeconds: () => number;
  /** Short internal diagnostics only; request secrets are never passed here. */
  logger: (line: string) => void;
}

/** Headers required on every public API response (there is deliberately no CORS header). */
export const BASE_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
};

export interface HealthResponse {
  ok: boolean;
  service: 'maa-manager';
  apiVersion: 'v1';
  readOnly: true;
  timeZone: 'Asia/Tokyo';
  generatedAt: string;
  uptimeSeconds: number;
}

function respond(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): ApiResponse {
  return { status, headers: { ...BASE_RESPONSE_HEADERS, ...extraHeaders }, body };
}

function readDateParam(query: Record<string, unknown>): unknown {
  return Object.hasOwn(query, 'date') ? query['date'] : undefined;
}

export class PublicApiService {
  private readonly limiter: RateLimiter;

  constructor(private readonly deps: PublicApiServiceDeps) {
    this.limiter = new RateLimiter(
      {
        perTokenLimit: deps.options.perTokenLimit,
        globalLimit: deps.options.globalLimit,
        windowMs: deps.options.rateWindowMs,
      },
      () => this.deps.now().getTime(),
    );
  }

  async handleHealth(request: ApiRequest): Promise<ApiResponse> {
    return this.handle(request, 'health');
  }

  /** Upstream response deadline advertised to the HTTP layer (Portal allows 10s). */
  get responseDeadlineMs(): number {
    return this.deps.options.responseDeadlineMs;
  }

  async handleDailyStatus(request: ApiRequest): Promise<ApiResponse> {
    return this.handle(request, 'daily-status');
  }

  private async handle(request: ApiRequest, endpoint: 'health' | 'daily-status'): Promise<ApiResponse> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return respond(405, errorBody('method_not_allowed'), { Allow: 'GET, HEAD' });
    }
    if (!this.deps.tokens.configured) {
      return respond(503, errorBody('not_configured'));
    }
    const verification = verifyBearer(request.headers['authorization'], this.deps.tokens.digests);
    if (!verification.ok || !verification.tokenKey) {
      return respond(401, errorBody('unauthorized'), { 'WWW-Authenticate': 'Bearer realm="bot-daily"' });
    }
    const limit = this.limiter.check(verification.tokenKey);
    if (!limit.allowed) {
      return respond(429, errorBody('rate_limited'), { 'Retry-After': String(limit.retryAfterSeconds) });
    }

    try {
      if (endpoint === 'health') return respond(200, this.health());
      return respond(200, await this.dailyStatus(request));
    } catch (error) {
      if (error instanceof PublicApiError) {
        return respond(error.status, errorBody(error.code, error.message));
      }
      // Never echo messages, stacks, paths, SQL or tokens. A short code is enough to triage.
      this.deps.logger(`[bot-daily-api] internal error (${errorCodeOf(error)})`);
      return respond(500, errorBody('internal_error'));
    }
  }

  private health(): HealthResponse {
    return {
      ok: true,
      service: 'maa-manager',
      apiVersion: 'v1',
      readOnly: true,
      timeZone: 'Asia/Tokyo',
      generatedAt: formatJst(this.deps.now()) ?? '',
      uptimeSeconds: Math.max(0, Math.floor(this.deps.uptimeSeconds())),
    };
  }

  private async dailyStatus(request: ApiRequest): Promise<DailyStatusResponse> {
    const now = this.deps.now();
    const dateKey = resolveDateKey(readDateParam(request.query), now, this.deps.options.maxLookbackDays);
    const window = dayWindow(dateKey);
    const snapshot = await this.deps.repository.readSnapshot(window, this.deps.options.takeCap);
    const engine = await this.deps.engine.read();
    return buildDailyStatus({
      now,
      date: dateKey,
      presets: snapshot.presets,
      schedules: snapshot.schedules,
      runs: snapshot.runs,
      engine,
      databaseReadAt: snapshot.databaseReadAt,
      truncated: snapshot.truncated,
      options: {
        maxLookbackDays: this.deps.options.maxLookbackDays,
        staleAfterSeconds: this.deps.options.staleAfterSeconds,
        takeCap: this.deps.options.takeCap,
      },
    });
  }
}

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(candidate.code)) return candidate.code;
  if (typeof candidate.name === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(candidate.name)) return candidate.name;
  return 'unknown';
}

