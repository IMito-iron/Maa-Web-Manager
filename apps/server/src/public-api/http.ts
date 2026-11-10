/**
 * Thin HTTP adapter: translate an Express request into the service's plain request type, then write
 * the service's plain response. All policy lives in `service.ts`; this file only touches transport
 * concerns (headers, status, body, the bounded response deadline and the Nest routing decorators).
 */
import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BASE_RESPONSE_HEADERS, PublicApiService, type ApiRequest, type ApiResponse } from './service';
import { errorBody } from './errors';

export const HEALTH_PATH = '/api/v1/public/health';
export const DAILY_STATUS_PATH = '/api/v1/public/daily-status';

/**
 * Exact public paths. Manager's same-origin/JSON middleware and Portal's origin middleware are
 * exempted for exactly these two paths (and nothing else): they own their own method and auth
 * policy, including returning JSON 405 for non-GET methods.
 */
export function isPublicApiPath(pathname: string): boolean {
  return pathname === HEALTH_PATH || pathname === DAILY_STATUS_PATH;
}

export function toApiRequest(request: Request): ApiRequest {
  return {
    method: request.method,
    headers: request.headers as Record<string, string | string[] | undefined>,
    query: request.query as Record<string, unknown>,
  };
}

/** Write an ApiResponse; HEAD bodies are suppressed by Node, Content-Length still describes them. */
export function writeResponse(response: Response, result: ApiResponse): void {
  if (response.writableEnded) return;
  response.status(result.status);
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  const body = result.body === undefined ? '' : JSON.stringify(result.body);
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  response.end(body);
}

/**
 * Serve one endpoint with a hard response deadline. The repository work is already bounded (row
 * caps + seven-day window); the deadline protects the socket if anything else stalls.
 */
export async function servePublicEndpoint(
  api: PublicApiService,
  endpoint: 'health' | 'daily-status',
  request: Request,
  response: Response,
): Promise<void> {
  const deadline = api.responseDeadlineMs;
  if (typeof response.setTimeout === 'function') {
    response.setTimeout(deadline, () => {
      if (response.writableEnded) return;
      if (!response.headersSent) {
        writeResponse(response, {
          status: 500,
          headers: { ...BASE_RESPONSE_HEADERS },
          body: errorBody('internal_error'),
        });
      } else {
        response.destroy();
      }
    });
  }
  let result: ApiResponse;
  try {
    result = endpoint === 'health'
      ? await api.handleHealth(toApiRequest(request))
      : await api.handleDailyStatus(toApiRequest(request));
  } catch {
    result = { status: 500, headers: { ...BASE_RESPONSE_HEADERS }, body: errorBody('internal_error') };
  }
  writeResponse(response, result);
  if (typeof response.setTimeout === 'function') response.setTimeout(0);
}

@Controller('api/v1/public')
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  @All('health')
  health(@Req() request: Request, @Res() response: Response): Promise<void> {
    return servePublicEndpoint(this.api, 'health', request, response);
  }

  @All('daily-status')
  dailyStatus(@Req() request: Request, @Res() response: Response): Promise<void> {
    return servePublicEndpoint(this.api, 'daily-status', request, response);
  }
}
