/**
 * Bot API token provisioning.
 *
 * The token list is loaded once at startup. An unreadable token file is logged as a short code and
 * leaves the API unconfigured (fail closed); it never crashes the process and the token value is
 * never logged. Comparison happens in constant time over SHA-256 digests, so neither the length nor
 * the byte values of a candidate leak through timing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface BotTokenEnv {
  BOT_DAILY_API_TOKEN?: string;
  BOT_DAILY_API_TOKEN_FILE?: string;
}

export interface TokenLoadResult {
  configured: boolean;
  /** SHA-256 digests of the accepted tokens; the plaintext tokens are not retained. */
  digests: Buffer[];
  source: 'env' | 'file' | 'none';
}

export type ReadTextFile = (path: string) => Promise<string>;

/** Accept `a,b`, whitespace- or newline-separated tokens; dedupe while preserving order. */
export function splitTokens(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  const tokens = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

export function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Load the accepted token set from env, falling back to the token file (read once). */
export async function loadBotTokens(
  env: BotTokenEnv,
  readFile: ReadTextFile,
  log: (line: string) => void,
): Promise<TokenLoadResult> {
  const fromEnv = splitTokens(env.BOT_DAILY_API_TOKEN);
  if (fromEnv.length > 0) {
    return { configured: true, digests: fromEnv.map(digestToken), source: 'env' };
  }
  const file = (env.BOT_DAILY_API_TOKEN_FILE ?? '').trim();
  if (!file) return { configured: false, digests: [], source: 'none' };
  try {
    const tokens = splitTokens(await readFile(file));
    if (tokens.length === 0) {
      log('[bot-daily-api] token file contained no token; bot API disabled');
      return { configured: false, digests: [], source: 'none' };
    }
    return { configured: true, digests: tokens.map(digestToken), source: 'file' };
  } catch (error) {
    const code =
      error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? ((error as { code: string }).code as string)
        : 'unreadable';
    log(`[bot-daily-api] token file could not be read (${code}); bot API disabled`);
    return { configured: false, digests: [], source: 'none' };
  }
}

/** Parse exactly `Bearer <token>` (scheme case-insensitive, one non-empty value). */
export function parseBearer(authorization: unknown): string | null {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

export interface TokenVerification {
  ok: boolean;
  /** Digest hex of the accepted token, used as the rate-limit key. Never returned to clients. */
  tokenKey: string | null;
}

/** Constant-time verification against every configured digest. */
export function verifyBearer(authorization: unknown, digests: Buffer[]): TokenVerification {
  const token = parseBearer(authorization);
  if (!token || digests.length === 0) return { ok: false, tokenKey: null };
  const candidate = digestToken(token);
  let ok = false;
  for (const expected of digests) {
    // timingSafeEqual must be evaluated for every configured token, so no early exit.
    const equal = timingSafeEqual(candidate, expected);
    ok = equal || ok;
  }
  return { ok, tokenKey: ok ? candidate.toString('hex') : null };
}
