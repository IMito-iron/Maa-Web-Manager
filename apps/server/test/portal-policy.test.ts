/**
 * Portal path-policy tests (Windows-safe: no Unix socket or child process involved).
 *
 * These pin the only forwarding branch the Portal ever adds for the public Bot API, and prove that
 * the pre-existing Manager allowlist / retired-API behaviour is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyApiUrl,
  isPublicApiUrl,
  pathnameOf,
  publicMethodAllowed,
  PUBLIC_API_FORWARDED_RESPONSE_HEADERS,
  PUBLIC_API_GATEWAY_TIMEOUT,
  PUBLIC_API_METHOD_NOT_ALLOWED,
  PUBLIC_API_UPSTREAM_ERROR,
  PUBLIC_API_UPSTREAM_TIMEOUT_MS,
  publicOriginAllowed,
} from '../src/portal-policy';

test('the two exact public API endpoints are classified as public, with any query string', () => {
  assert.deepEqual(classifyApiUrl('/api/v1/public/health'), { kind: 'public', endpoint: 'health' });
  assert.deepEqual(classifyApiUrl('/api/v1/public/health?probe=1'), { kind: 'public', endpoint: 'health' });
  assert.deepEqual(classifyApiUrl('/api/v1/public/daily-status'), { kind: 'public', endpoint: 'daily-status' });
  assert.deepEqual(classifyApiUrl('/api/v1/public/daily-status?date=2026-11-06'), {
    kind: 'public',
    endpoint: 'daily-status',
  });
  assert.equal(isPublicApiUrl('/api/v1/public/health'), true);
  assert.equal(isPublicApiUrl('/api/v1/public/daily-status?date=2026-11-06'), true);
});

test('no wildcard/prefix/encoded bypass is accepted for public API paths', () => {
  const retired = [
    '/api/v1/public/',
    '/api/v1/public',
    '/api/v1/public/health/',
    '/api/v1/public/health/extra',
    '/api/v1/public/healthx',
    '/api/v1/public/daily-status/extra',
    '/api/v1/public/%68ealth',
    '/api/v1/public/health%2F..%2Fcontrol',
    '/api/v1/public/health/../control',
    '/api/v1/public/*',
    '/api/v1/private/health',
    '/apiv1/public/health',
    '',
  ];
  for (const url of retired) {
    assert.deepEqual(classifyApiUrl(url), { kind: 'retired' }, url);
    assert.equal(isPublicApiUrl(url), false, url);
  }
});

test('the pre-existing Manager allowlist is unchanged and still never returned publicly', () => {
  for (const url of [
    '/api/health',
    '/api/status',
    '/api/devices',
    '/api/tasks',
    '/api/tasks/preset-a',
    '/api/queue',
    '/api/runs/11111111-1111-4111-8111-111111111111',
    '/api/runs/11111111-1111-4111-8111-111111111111/log',
    '/api/schedules',
    '/api/events',
    '/api/control',
    '/api/control/heartbeat',
    '/api/control/screen-off',
    '/api/status?x=1',
    '/api/stages?client=Official', // WIN-PARITY: editor stage dropdown (read-only)
  ]) {
    assert.deepEqual(classifyApiUrl(url), { kind: 'manager' }, url);
  }
  // Retired/unknown APIs stay retired (Portal answers 410 exactly as before).
  for (const url of [
    '/api/auth/me',
    '/api/workspace/tasks',
    '/api/runner/tasks',
    '/api/v1/publicx/health',
    '/api/controlx',
    '/api/tasksx',
    '/api/stagesx',
  ]) {
    assert.deepEqual(classifyApiUrl(url), { kind: 'retired' }, url);
  }
});

test('public method policy is GET/HEAD only', () => {
  for (const method of ['GET', 'HEAD', 'get', 'head']) assert.equal(publicMethodAllowed(method), true, method);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', '', undefined, null]) {
    assert.equal(publicMethodAllowed(method), false, String(method));
  }
});

test('Portal error bodies and the upstream timeout are fixed', () => {
  assert.deepEqual(PUBLIC_API_METHOD_NOT_ALLOWED, {
    error: { code: 'method_not_allowed', message: 'Only GET is allowed' },
  });
  assert.deepEqual(PUBLIC_API_GATEWAY_TIMEOUT, { error: { code: 'gateway_timeout', message: 'Upstream timeout' } });
  assert.deepEqual(PUBLIC_API_UPSTREAM_ERROR, { error: { code: 'upstream_error', message: 'Upstream unavailable' } });
  assert.equal(PUBLIC_API_UPSTREAM_TIMEOUT_MS, 10_000);
});

test('forwarded upstream response headers never include CORS, cookies or credentials', () => {
  for (const forbidden of ['access-control-allow-origin', 'access-control-allow-credentials', 'set-cookie', 'authorization']) {
    assert.equal(
      (PUBLIC_API_FORWARDED_RESPONSE_HEADERS as readonly string[]).includes(forbidden),
      false,
      forbidden,
    );
  }
  for (const allowed of ['content-type', 'cache-control', 'pragma', 'x-content-type-options', 'www-authenticate', 'retry-after', 'allow']) {
    assert.equal((PUBLIC_API_FORWARDED_RESPONSE_HEADERS as readonly string[]).includes(allowed), true, allowed);
  }
});

test('pathnameOf strips query and fragment without decoding', () => {
  assert.equal(pathnameOf('/api/v1/public/health?date=2026-11-06'), '/api/v1/public/health');
  assert.equal(pathnameOf('/api/v1/public/health#x'), '/api/v1/public/health');
  assert.equal(pathnameOf('/api/v1/public/%68ealth'), '/api/v1/public/%68ealth');
  assert.equal(pathnameOf(''), '');
});

test('PUBLIC_ORIGIN: https anywhere, plain http only on loopback', () => {
  for (const ok of ['https://maa.example.com', 'https://maa.example.com:8443', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'])
    assert.equal(publicOriginAllowed(ok), true, ok);
  for (const bad of [undefined, '', 'http://10.0.0.5:8080', 'http://maa.example.com', 'https://maa.example.com/path', 'ftp://localhost', 'not a url'])
    assert.equal(publicOriginAllowed(bad), false, String(bad));
});
