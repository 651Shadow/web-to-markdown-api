import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { __testables } from '../api/index';

function createMockRequest(options: {
  method?: string;
  url?: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
}): VercelRequest {
  return {
    method: options.method || 'GET',
    url: options.url,
    query: options.query || {},
    body: options.body,
    headers: options.headers || {},
  } as unknown as VercelRequest;
}

function createMockResponse(): VercelResponse & {
  _status: number;
  _headers: Record<string, string>;
  _json: unknown;
  _body: unknown;
  _ended: boolean;
} {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _json: null as unknown,
    _body: null as unknown,
    _ended: false,
    status(code: number) {
      this._status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this._headers[name] = value;
      return this;
    },
    json(data: unknown) {
      this._json = data;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
    end() {
      this._ended = true;
      return this;
    },
  };

  return res as unknown as VercelResponse & typeof res;
}

describe('web-to-markdown handler hardening', () => {
  beforeEach(() => {
    delete process.env.RAPIDAPI_SECRET;
    delete process.env.ADMIN_SECRET;
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    process.env.ALLOW_UNAUTHENTICATED_DEV = 'true';
    __testables.resetRateLimitStore();
    vi.restoreAllMocks();
  });

  it('fails closed when auth secrets are missing and dev bypass is off', async () => {
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      query: { url: 'https://example.com/article' },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toEqual({
      error: 'FORBIDDEN',
      message: expect.stringContaining('Server authentication is not configured'),
      code: 503,
    });
  });

  it('accepts admin-secret authenticated requests', async () => {
    process.env.ADMIN_SECRET = 'shadow-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'POST',
      body: '<html><body><article><h1>Hello</h1><p>World</p></article></body></html>',
      headers: {
        'content-type': 'text/html',
        'x-admin-key': 'shadow-secret',
        'x-forwarded-for': '203.0.113.10',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-RateLimit-Limit']).toBeDefined();
    expect((res._json as { source: string }).source).toBe('html');
  });

  it('rate limits repeated requests from the same client IP', async () => {
    process.env.RATE_LIMIT_MAX = '1';

    const req = createMockRequest({
      method: 'POST',
      body: '<html><body><p>Hello</p></body></html>',
      headers: {
        'content-type': 'text/html',
        'x-forwarded-for': '198.51.100.44',
      },
    });

    const first = createMockResponse();
    await handler(req, first);
    expect(first._status).toBe(200);

    const second = createMockResponse();
    await handler(req, second);
    expect(second._status).toBe(429);
    expect(second._json).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      code: 429,
    });
  });

  it('returns 200 HTML landing page for unauthenticated bare browser GET / even when auth is enforced', async () => {
    process.env.RAPIDAPI_SECRET = 'rapid-secret';
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('text/html');
    expect(res._headers['Vary']).toBe('Accept');
    expect(typeof res._body).toBe('string');
    const html = res._body as string;
    expect(html).toContain('Web to Markdown API');
    expect(html).toContain('x-rapidapi-proxy-secret');
    expect(html).toContain('x-admin-key');
    expect(html).toContain('POST');
    expect(html).toContain('?url=');
  });

  it('returns 200 JSON landing info for unauthenticated bare GET / without text/html Accept header', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/',
      headers: {
        accept: 'application/json',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Vary']).toBe('Accept');
    expect(res._json).toMatchObject({
      service: 'web-to-markdown-api',
      status: 'ok',
      authentication: {
        required_for_conversion: true,
        headers: ['x-rapidapi-proxy-secret', 'x-admin-key'],
      },
    });
    const json = res._json as { endpoints: unknown[]; usage: Record<string, string> };
    expect(Array.isArray(json.endpoints)).toBe(true);
    expect(json.usage.get_url).toContain('x-rapidapi-proxy-secret');
  });

  it('returns 200 landing response for bare GET / even when secrets are unconfigured', async () => {
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect((res._json as { service: string }).service).toBe('web-to-markdown-api');
  });

  it('keeps GET /?url=... strictly fail-closed behind auth', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/?url=https://example.com/article',
      query: { url: 'https://example.com/article' },
      headers: {
        accept: 'text/html',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({
      error: 'FORBIDDEN',
      message: 'Invalid or missing authentication credentials',
      code: 403,
    });
  });

  it('keeps GET with empty ?url= or conversion query params strictly fail-closed', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    for (const url of ['/?url=', '/?base_url=https://example.com', '/?html=%3Cp%3Ehi%3C/p%3E']) {
      const req = createMockRequest({
        method: 'GET',
        url,
        headers: { accept: 'text/html' },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res._status).toBe(403);
      expect((res._json as { error: string }).error).toBe('FORBIDDEN');
    }
  });

  it('keeps POST / strictly fail-closed behind auth', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'POST',
      url: '/',
      body: { url: 'https://example.com/article' },
      headers: {
        'content-type': 'application/json',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe('FORBIDDEN');
  });

  it('keeps POST / fail-closed with 503 when auth secrets are missing', async () => {
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'POST',
      url: '/',
      body: { html: '<p>Hello</p>' },
      headers: { 'content-type': 'application/json' },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(503);
    expect((res._json as { error: string }).error).toBe('FORBIDDEN');
  });

  it('rejects invalid auth headers even on bare GET /', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/',
      headers: {
        'x-admin-key': 'wrong-secret',
        accept: 'text/html',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe('FORBIDDEN');
  });

  it('preserves 400 MISSING_INPUT on authenticated bare GET /', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/',
      headers: {
        'x-admin-key': 'admin-secret',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toBe('MISSING_INPUT');
  });

  it('keeps non-root GET paths behind auth', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      url: '/not-root',
      headers: { accept: 'text/html' },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe('FORBIDDEN');
  });
});
