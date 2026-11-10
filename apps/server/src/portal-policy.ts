/**
 * Pure path/method policy for the Portal's public Bot API branch.
 *
 * The Portal is the only process that can reach the Manager's private control socket, so its
 * allowlist is the security boundary for everything under `/api`. The public branch is deliberately
 * exact: two literal paths, GET/HEAD only, no query parameter allowlisting needed (Manager validates
 * `date`), no cookies, no `x-control-token`, and no wildcard/prefix matching. Everything else keeps
 * the pre-existing behaviour: the Manager allowlist is proxied unchanged, and unknown/retired paths
 * still return 410.
 */
import type { ApiErrorBody } from './public-api/errors';

/** Portal gives up on the Manager well before its own 10s upstream allowance is exhausted. */
export const PUBLIC_API_UPSTREAM_TIMEOUT_MS = 10_000;

export const PUBLIC_API_ALLOWED_METHODS = ['GET', 'HEAD'] as const;

/** Upstream response headers that are safe to relay (no CORS, cookies, or hop-by-hop headers). */
export const PUBLIC_API_FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'pragma',
  'x-content-type-options',
  'www-authenticate',
  'retry-after',
  'allow',
] as const;

export const PUBLIC_API_METHOD_NOT_ALLOWED: ApiErrorBody = {
  error: { code: 'method_not_allowed', message: 'Only GET is allowed' },
};

export const PUBLIC_API_GATEWAY_TIMEOUT: ApiErrorBody = {
  error: { code: 'gateway_timeout', message: 'Upstream timeout' },
};

export const PUBLIC_API_UPSTREAM_ERROR: ApiErrorBody = {
  error: { code: 'upstream_error', message: 'Upstream unavailable' },
};

export type PublicApiEndpoint = 'health' | 'daily-status';

export type ApiPathClassification =
  | { kind: 'public'; endpoint: PublicApiEndpoint }
  | { kind: 'manager' }
  | { kind: 'retired' };

/** The pre-existing Manager allowlist, applied to the URL after the `/api` mount is stripped. */
const MANAGER_ALLOWLIST = /^\/(health|status|devices|tasks|queue|runs|schedules|events|control|stages)(\/|$)/;

const PUBLIC_URL = /^\/api\/v1\/public\/(health|daily-status)(?:\?[^#]*)?$/;

/** Split the pathname out of a request URL without decoding it (encoded separators stay unmatched). */
export function pathnameOf(rawUrl: string): string {
  if (typeof rawUrl !== 'string') return '';
  return rawUrl.split('#')[0]?.split('?')[0] ?? '';
}

/** True only for the two exact public API endpoints. */
export function isPublicApiUrl(rawUrl: string): boolean {
  return PUBLIC_URL.test(typeof rawUrl === 'string' ? rawUrl.split('#')[0] ?? '' : '');
}

export function publicMethodAllowed(method: unknown): boolean {
  return typeof method === 'string' && (PUBLIC_API_ALLOWED_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Classify a URL as seen by Portal: `public` for the two exact endpoints, `manager` when the
 * pre-existing allowlist would proxy it, `retired` otherwise (Portal returns 410).
 */
export function classifyApiUrl(rawUrl: string): ApiPathClassification {
  const url = typeof rawUrl === 'string' ? rawUrl.split('#')[0] ?? '' : '';
  const match = PUBLIC_URL.exec(url);
  if (match) {
    const endpoint = match[1] === 'health' ? 'health' : 'daily-status';
    return { kind: 'public', endpoint };
  }
  const pathname = pathnameOf(url);
  const stripped = pathname.startsWith('/api') ? pathname.slice('/api'.length) : pathname;
  if (MANAGER_ALLOWLIST.test(stripped)) return { kind: 'manager' };
  return { kind: 'retired' };
}

/**
 * PUBLIC_ORIGIN must be HTTPS, except for loopback trials (http://localhost, http://127.0.0.1,
 * http://[::1]): browsers treat those as secure contexts, so the `__Host-` Secure control cookie
 * still works, while nothing is served over plain HTTP to another machine.
 */
export function publicOriginAllowed(value: string | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== value.replace(/\/$/, '')) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
