/**
 * Environment parsing for the Bot API. Kept out of `config.ts` so the values are explicitly
 * bounded and so tests can build options without touching the process environment.
 */
export interface BotApiOptions {
  /** Allowed `?date=` lookback in days, inclusive of today. */
  maxLookbackDays: number;
  /** Age after which `freshness.stale` becomes true. */
  staleAfterSeconds: number;
  /** Hard row cap per storage query. */
  takeCap: number;
  /** Per-token requests per fixed one-minute window. */
  perTokenLimit: number;
  /** Global requests per fixed one-minute window across all tokens. */
  globalLimit: number;
  rateWindowMs: number;
  /** Upstream response deadline in milliseconds (Portal uses a 10s upstream timeout). */
  responseDeadlineMs: number;
}

export const BOT_API_DEFAULTS: BotApiOptions = {
  maxLookbackDays: 7,
  staleAfterSeconds: 300,
  takeCap: 5000,
  perTokenLimit: 60,
  globalLimit: 300,
  rateWindowMs: 60_000,
  responseDeadlineMs: 5000,
};

export function envInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function botApiOptions(env: Record<string, string | undefined>): BotApiOptions {
  return {
    maxLookbackDays: envInt(env, 'BOT_DAILY_MAX_LOOKBACK_DAYS', BOT_API_DEFAULTS.maxLookbackDays, 0, 31),
    staleAfterSeconds: envInt(env, 'BOT_DAILY_STALE_AFTER_SECONDS', BOT_API_DEFAULTS.staleAfterSeconds, 30, 86_400),
    takeCap: envInt(env, 'BOT_DAILY_MAX_ROWS', BOT_API_DEFAULTS.takeCap, 1, 50_000),
    perTokenLimit: envInt(env, 'BOT_DAILY_RATE_LIMIT_PER_MINUTE', BOT_API_DEFAULTS.perTokenLimit, 1, 100_000),
    globalLimit: envInt(env, 'BOT_DAILY_RATE_LIMIT_GLOBAL_PER_MINUTE', BOT_API_DEFAULTS.globalLimit, 1, 100_000),
    rateWindowMs: BOT_API_DEFAULTS.rateWindowMs,
    responseDeadlineMs: envInt(env, 'BOT_DAILY_RESPONSE_DEADLINE_MS', BOT_API_DEFAULTS.responseDeadlineMs, 500, 60_000),
  };
}
