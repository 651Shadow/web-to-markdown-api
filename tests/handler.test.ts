import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { __testables } from '../api/index';

function createMockRequest(options: {
  method?: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
}): VercelRequest {
  return {
    method: options.method || 'GET',
    query: options.query || {},
    body: options.body,
    headers: options.headers || {},
  } as unknown as VercelRequest;
}

function createMockResponse(): VercelResponse & {
  _status: number;
  _headers: Record<string, string>;
  _json: unknown;
  _ended: boolean;
} {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _json: null as unknown,
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
});
