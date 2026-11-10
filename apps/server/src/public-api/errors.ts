/**
 * Closed error vocabulary for the public Bot API. Every response body is `{error:{code,message}}`;
 * messages are fixed strings so no internal state, path, stack or SQL can leak through them.
 */
export type PublicApiErrorCode =
  | 'invalid_date'
  | 'date_out_of_range'
  | 'unauthorized'
  | 'method_not_allowed'
  | 'rate_limited'
  | 'not_configured'
  | 'internal_error'
  | 'gateway_timeout'
  | 'upstream_error';

export interface ApiErrorBody {
  error: { code: PublicApiErrorCode; message: string };
}

const MESSAGES: Record<PublicApiErrorCode, string> = {
  invalid_date: 'Invalid date; expected YYYY-MM-DD',
  date_out_of_range: 'Date is outside the allowed range',
  unauthorized: 'Missing or invalid bot token',
  method_not_allowed: 'Only GET is allowed',
  rate_limited: 'Too many requests',
  not_configured: 'Bot API token is not configured',
  internal_error: 'Internal error',
  gateway_timeout: 'Upstream timeout',
  upstream_error: 'Upstream unavailable',
};

export function errorBody(code: PublicApiErrorCode, message?: string): ApiErrorBody {
  return { error: { code, message: message ?? MESSAGES[code] } };
}

/** A failure that maps to a fixed HTTP status/body without leaking internals. */
export class PublicApiError extends Error {
  constructor(
    readonly code: PublicApiErrorCode,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
    this.name = 'PublicApiError';
  }
}

export function invalidDate(message?: string): PublicApiError {
  return new PublicApiError('invalid_date', 400, message);
}

export function dateOutOfRange(): PublicApiError {
  return new PublicApiError('date_out_of_range', 400);
}
