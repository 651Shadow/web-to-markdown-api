import http from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { handleRequest } from '../api/index';
import type { SafeFetchOptions } from '../src/fetch/safeFetch';
import {
  checkRateLimit,
  getRateLimitStoreSize,
  resetRateLimitStore,
} from '../src/security/rateLimit';

function createMockRequest(options: {
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string | string[]>;
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

describe('web-to-markdown handler hardening & regression suite', () => {
  beforeEach(() => {
    delete process.env.RAPIDAPI_SECRET;
    delete process.env.ADMIN_SECRET;
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    process.env.ALLOW_UNAUTHENTICATED_DEV = 'true';
    resetRateLimitStore();
    vi.restoreAllMocks();
  });

  it('fails closed with 503 AUTH_NOT_CONFIGURED when auth secrets are missing and dev bypass is off', async () => {
    delete process.env.ALLOW_UNAUTHENTICATED_DEV;

    const req = createMockRequest({
      method: 'GET',
      query: { url: 'https://example.com/article' },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toEqual({
      error: 'AUTH_NOT_CONFIGURED',
      message: expect.stringContaining('Server authentication is not configured'),
      code: 503,
    });
  });

  it('accepts admin-secret authenticated requests and omits Retry-After on 200 OK', async () => {
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
    expect(res._headers['X-RateLimit-Reset']).toBeDefined();
    expect(res._headers['Retry-After']).toBeUndefined();
    expect((res._json as { source: string }).source).toBe('html');
  });

  it('rate limits repeated requests, emits Retry-After only on 429, and prioritizes x-real-ip over x-forwarded-for', async () => {
    process.env.RATE_LIMIT_MAX = '1';

    const first = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        body: '<html><body><p>Hello</p></body></html>',
        headers: {
          'content-type': 'text/html',
          'x-real-ip': '198.51.100.44',
          'x-forwarded-for': '203.0.113.1',
        },
      }),
      first
    );
    expect(first._status).toBe(200);
    expect(first._headers['Retry-After']).toBeUndefined();

    // Spoofing a new x-forwarded-for does not bypass rate limit when x-real-ip is the same
    const second = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        body: '<html><body><p>Hello</p></body></html>',
        headers: {
          'content-type': 'text/html',
          'x-real-ip': '198.51.100.44',
          'x-forwarded-for': '203.0.113.99',
        },
      }),
      second
    );
    expect(second._status).toBe(429);
    expect(second._headers['Retry-After']).toBeDefined();
    expect(second._json).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      code: 429,
    });
  });

  it('honors RATE_LIMIT_MAX=0, falls back safely on non-numeric RATE_LIMIT_MAX, and evicts expired keys', async () => {
    process.env.RATE_LIMIT_MAX = '0';
    const blockedRes = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        body: '<p>Test</p>',
        headers: { 'content-type': 'text/html', 'x-real-ip': '198.51.100.50' },
      }),
      blockedRes
    );
    expect(blockedRes._status).toBe(429);

    resetRateLimitStore();
    process.env.RATE_LIMIT_MAX = 'not-a-number';
    const fallbackRes = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        body: '<p>Test</p>',
        headers: { 'content-type': 'text/html', 'x-real-ip': '198.51.100.51' },
      }),
      fallbackRes
    );
    expect(fallbackRes._status).toBe(200);
    expect(fallbackRes._headers['X-RateLimit-Limit']).toBe('30');

    // Verify expired keys are evicted on subsequent checks
    resetRateLimitStore();
    process.env.RATE_LIMIT_WINDOW_MS = '10';
    checkRateLimit('198.51.100.1');
    checkRateLimit('198.51.100.2');
    expect(getRateLimitStoreSize()).toBe(2);

    await new Promise((r) => setTimeout(r, 25));
    checkRateLimit('198.51.100.3');
    expect(getRateLimitStoreSize()).toBe(1);
  });

  it('validates runtime input types and distinguishes EMPTY_HTML from MISSING_INPUT', async () => {
    // Non-string html field: {"html": 123}
    const nonStringHtmlRes = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { html: 123 },
      }),
      nonStringHtmlRes
    );
    expect(nonStringHtmlRes._status).toBe(400);
    expect((nonStringHtmlRes._json as { error: string }).error).toBe('INVALID_INPUT');

    // Duplicate query parameter: ?url=a&url=b
    const arrayUrlRes = createMockResponse();
    await handler(
      createMockRequest({
        method: 'GET',
        query: { url: ['https://example.com/a', 'https://example.com/b'] },
      }),
      arrayUrlRes
    );
    expect(arrayUrlRes._status).toBe(400);
    expect((arrayUrlRes._json as { error: string }).error).toBe('INVALID_INPUT');

    // Empty string HTML: {"html": ""} -> EMPTY_HTML (not MISSING_INPUT)
    const emptyHtmlRes = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { html: '' },
      }),
      emptyHtmlRes
    );
    expect(emptyHtmlRes._status).toBe(400);
    expect((emptyHtmlRes._json as { error: string }).error).toBe('EMPTY_HTML');

    // Missing input: {} -> MISSING_INPUT
    const missingRes = createMockResponse();
    await handler(
      createMockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {},
      }),
      missingRes
    );
    expect(missingRes._status).toBe(400);
    expect((missingRes._json as { error: string }).error).toBe('MISSING_INPUT');
  });

  describe('URL fetch mode with hop-by-hop redirect & streaming enforcement', () => {
    let server: http.Server;
    let port: number;
    let privateHopTouched = false;
    let fetchOptions: SafeFetchOptions;

    beforeEach(async () => {
      privateHopTouched = false;

      fetchOptions = {
        connectAddress: '127.0.0.1',
        lookupFn: async (hostname) => {
          if (hostname === 'public.example.test' || hostname === 'cdn.example.test') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          if (hostname === 'internal.corp.test') {
            return [{ address: '10.0.0.99', family: 4 }];
          }
          throw new Error('ENOTFOUND');
        },
      };

      server = http.createServer((req, res) => {
        if (req.url === '/redirect-to-docs') {
          res.writeHead(302, {
            Location: `http://cdn.example.test:${port}/docs/v2/guide.html`,
          });
          res.end();
          return;
        }

        if (req.url === '/docs/v2/guide.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<html><head><title>V2 Guide</title></head><body><article><header><h1>Guide</h1></header><p>Read <a href="install.html">Install</a></p></article></body></html>'
          );
          return;
        }

        if (req.url === '/redirect-to-private') {
          res.writeHead(302, {
            Location: `http://internal.corp.test:${port}/private-hop`,
          });
          res.end();
          return;
        }

        if (req.url === '/private-hop') {
          privateHopTouched = true;
          res.writeHead(302, {
            Location: `http://public.example.test:${port}/docs/v2/guide.html`,
          });
          res.end();
          return;
        }

        if (req.url === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hello: 'world' }));
          return;
        }

        if (req.url === '/gzip-bomb') {
          const bigPayload = '<html><body><p>' + 'A'.repeat(2 * 1024 * 1024 + 4096) + '</p></body></html>';
          const compressed = gzipSync(Buffer.from(bigPayload, 'utf8'));
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Encoding': 'gzip',
          });
          res.end(compressed);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('propagates finalUrl after redirects and resolves relative links against finalUrl', async () => {
      const req = createMockRequest({
        method: 'GET',
        query: { url: `http://public.example.test:${port}/redirect-to-docs` },
      });
      const res = createMockResponse();

      await handleRequest(req, res, fetchOptions);

      expect(res._status).toBe(200);
      const body = res._json as {
        url: string;
        source: string;
        markdown: string;
        meta: { title: string };
      };
      expect(body.source).toBe('url');
      expect(body.url).toBe(`http://cdn.example.test:${port}/docs/v2/guide.html`);
      expect(body.meta.title).toBe('V2 Guide');
      expect(body.markdown).toContain('# Guide');
      expect(body.markdown).toContain(
        `[Install](http://cdn.example.test:${port}/docs/v2/install.html)`
      );
    });

    it('blocks intermediate redirect hops targeting private IPs before connecting', async () => {
      const req = createMockRequest({
        method: 'GET',
        query: { url: `http://public.example.test:${port}/redirect-to-private` },
      });
      const res = createMockResponse();

      await handleRequest(req, res, fetchOptions);

      expect(res._status).toBe(403);
      expect((res._json as { error: string }).error).toBe('SSRF_BLOCKED');
      expect(privateHopTouched).toBe(false);
    });

    it('returns 415 UNSUPPORTED_MEDIA_TYPE for non-HTML responses', async () => {
      const req = createMockRequest({
        method: 'GET',
        query: { url: `http://public.example.test:${port}/json` },
      });
      const res = createMockResponse();

      await handleRequest(req, res, fetchOptions);

      expect(res._status).toBe(415);
      expect((res._json as { error: string }).error).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('enforces the streaming decompressed byte limit on gzip-compressed responses (413)', async () => {
      const req = createMockRequest({
        method: 'GET',
        query: { url: `http://public.example.test:${port}/gzip-bomb` },
      });
      const res = createMockResponse();

      await handleRequest(req, res, fetchOptions);

      expect(res._status).toBe(413);
      expect((res._json as { error: string }).error).toBe('PAGE_TOO_LARGE');
    });

    it('reads raw stream fallback when Content-Type: text/html leaves req.body undefined (Vercel parity)', async () => {
      const streamReq = Readable.from([
        Buffer.from('<html><body><h1>Streamed HTML</h1><p>Works without req.body</p></body></html>'),
      ]) as unknown as VercelRequest & { method: string; query: Record<string, unknown>; headers: Record<string, string>; body?: unknown };
      streamReq.method = 'POST';
      streamReq.query = {};
      streamReq.headers = { 'content-type': 'text/html; charset=utf-8' };
      streamReq.body = undefined;

      const res = createMockResponse();
      await handler(streamReq, res);

      expect(res._status).toBe(200);
      expect((res._json as { markdown: string }).markdown).toContain('# Streamed HTML');
    });

    it('returns 400 INVALID_INPUT when Vercel lazy req.body getter throws on malformed JSON', async () => {
      const lazyErrorReq = {
        method: 'POST',
        query: {},
        headers: { 'content-type': 'application/json' },
        get body() {
          throw new Error('Invalid JSON');
        },
      } as unknown as VercelRequest;

      const res = createMockResponse();
      await handler(lazyErrorReq, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toBe('INVALID_INPUT');
    });

    it('handles synchronous socket connect failures without crashing the process', async () => {
      let uncaught: unknown = null;
      const listener = (err: unknown) => {
        uncaught = err;
      };
      process.once('uncaughtException', listener);

      try {
        const res = createMockResponse();
        await handleRequest(
          createMockRequest({
            method: 'GET',
            query: { url: `http://public.example.test:${port}/docs/v2/guide.html` },
          }),
          res,
          {
            ...fetchOptions,
            // Force a family/connect error cleanly
            connectAddress: '::1',
          }
        );

        await new Promise((r) => setTimeout(r, 30));
        expect(uncaught).toBeNull();
        expect([502, 504].includes(res._status)).toBe(true);
      } finally {
        process.removeListener('uncaughtException', listener);
      }
    });

    it('rejects chunked gzip payloads whose compressed wire bytes exceed maxBytes (413)', async () => {
      // Build a gzip buffer > 4096 bytes of comment/zero padding decompressing to tiny HTML
      const largeCompressed = gzipSync(Buffer.from('<html><body><p>' + ' '.repeat(128 * 1024) + '</p></body></html>'));
      const wireCheckServer = http.createServer((_req, serverRes) => {
        serverRes.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Encoding': 'gzip',
          'Transfer-Encoding': 'chunked',
        });
        serverRes.end(largeCompressed);
      });
      await new Promise<void>((resolve) => wireCheckServer.listen(0, '127.0.0.1', resolve));
      const addr = wireCheckServer.address();
      const wirePort = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const res = createMockResponse();
        await handleRequest(
          createMockRequest({
            method: 'GET',
            query: { url: `http://public.example.test:${wirePort}/wire` },
          }),
          res,
          { ...fetchOptions, maxBytes: 200 }
        );
        expect(res._status).toBe(413);
        expect((res._json as { error: string }).error).toBe('PAGE_TOO_LARGE');
      } finally {
        await new Promise<void>((resolve) => wireCheckServer.close(() => resolve()));
      }
    });

    it('rejects unsupported or stacked Content-Encoding with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      const encServer = http.createServer((_req, serverRes) => {
        serverRes.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Encoding': 'gzip, gzip',
        });
        serverRes.end('raw');
      });
      await new Promise<void>((resolve) => encServer.listen(0, '127.0.0.1', resolve));
      const addr = encServer.address();
      const encPort = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const res = createMockResponse();
        await handleRequest(
          createMockRequest({
            method: 'GET',
            query: { url: `http://public.example.test:${encPort}/stacked` },
          }),
          res,
          fetchOptions
        );
        expect(res._status).toBe(415);
        expect((res._json as { error: string }).error).toBe('UNSUPPORTED_MEDIA_TYPE');
      } finally {
        await new Promise<void>((resolve) => encServer.close(() => resolve()));
      }
    });

    it('destroys slow redirect sockets promptly after following 3xx redirects', async () => {
      let slowClosedEarly = false;
      const redirectServer = http.createServer((req, serverRes) => {
        if (req.url === '/slow-302') {
          serverRes.writeHead(302, { Location: `http://public.example.test:${port}/docs/v2/guide.html` });
          serverRes.write('slow redirect body');
          serverRes.on('close', () => {
            slowClosedEarly = true;
          });
          return;
        }
        serverRes.writeHead(404);
        serverRes.end();
      });
      await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
      const addr = redirectServer.address();
      const redirPort = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const res = createMockResponse();
        await handleRequest(
          createMockRequest({
            method: 'GET',
            query: { url: `http://public.example.test:${redirPort}/slow-302` },
          }),
          res,
          fetchOptions
        );
        await new Promise((r) => setTimeout(r, 30));
        expect(res._status).toBe(200);
        expect(slowClosedEarly).toBe(true);
      } finally {
        await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
      }
    });
  });
});
