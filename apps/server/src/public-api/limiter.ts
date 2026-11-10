/**
 * In-memory rate limiting for the public Bot API.
 *
 * Fixed one-minute windows, keyed by the SHA-256 digest of the presented token (never the token
 * itself) plus a global counter. Nothing is persisted and nothing is written to disk. The instance
 * is owned by the module that serves the API; there is no other mutable global state.
 */
export interface RateLimitOptions {
  perTokenLimit: number;
  globalLimit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Counter {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private readonly global: Counter = { windowStart: 0, count: 0 };
  private readonly tokens = new Map<string, Counter>();

  constructor(
    private readonly options: RateLimitOptions,
    private readonly nowMs: () => number,
  ) {}

  /** Count one authenticated request. Unauthenticated requests must never reach this method. */
  check(tokenKey: string): RateLimitDecision {
    const now = this.nowMs();
    const windowMs = Math.max(1000, this.options.windowMs);
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

    if (this.global.windowStart !== windowStart) {
      this.global.windowStart = windowStart;
      this.global.count = 0;
      // Opportunistic cleanup keeps the map bounded if many tokens are rotated over time.
      if (this.tokens.size > 1024) {
        for (const [key, counter] of this.tokens) {
          if (counter.windowStart !== windowStart) this.tokens.delete(key);
        }
      }
    }
    if (this.global.count >= Math.max(1, this.options.globalLimit)) {
      return { allowed: false, retryAfterSeconds };
    }

    const counter = this.tokens.get(tokenKey);
    if (counter && counter.windowStart === windowStart) {
      if (counter.count >= Math.max(1, this.options.perTokenLimit)) {
        return { allowed: false, retryAfterSeconds };
      }
      counter.count += 1;
    } else {
      this.tokens.set(tokenKey, { windowStart, count: 1 });
    }
    this.global.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
