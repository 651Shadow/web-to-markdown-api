import http from 'node:http';
import https from 'node:https';
import type { LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  FETCH_TIMEOUT_MS,
  MAX_CONTENT_LENGTH,
  MAX_REDIRECTS,
  USER_AGENT,
} from '../config';
import { ApiError } from '../errors';
import {
  resolveSafeTarget,
  type DnsLookupFn,
  type ResolvedTarget,
} from '../security/ssrf';

export interface SafeFetchOptions {
  lookupFn?: DnsLookupFn;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  connectAddress?: string;
}

export interface SafeFetchResult {
  html: string;
  finalUrl: string;
  originalLength: number;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  const lookup = (
    _hostname: string,
    options: LookupOptions | PinnedLookupCallback,
    callback?: PinnedLookupCallback
  ): void => {
    if (typeof options === 'function') {
      options(null, address, family);
      return;
    }
    if (options && typeof options === 'object' && 'all' in options && options.all) {
      callback?.(null, [{ address, family }]);
      return;
    }
    callback?.(null, address, family);
  };
  return lookup as LookupFunction;
}

function isHtmlContentType(contentTypeHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join('; ')
    : contentTypeHeader ?? '';
  const normalized = raw.toLowerCase();
  return (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml')
  );
}

function createDecodedStream(res: http.IncomingMessage): Readable {
  const encoding = (res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    const gunzip = createGunzip();
    res.pipe(gunzip);
    return gunzip;
  }
  if (encoding === 'deflate') {
    const inflate = createInflate();
    res.pipe(inflate);
    return inflate;
  }
  if (encoding === 'br') {
    const brotli = createBrotliDecompress();
    res.pipe(brotli);
    return brotli;
  }
  return res;
}

type HopResult =
  | { kind: 'redirect'; nextUrl: URL }
  | { kind: 'final'; html: string; finalUrl: string; originalLength: number };

function executeHop(
  target: ResolvedTarget,
  maxBytes: number,
  remainingTimeoutMs: number,
  connectAddress?: string
): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    let decodedStream: Readable | null = null;
    let currentRes: http.IncomingMessage | null = null;

    const finishReject = (err: ApiError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      decodedStream?.destroy();
      currentRes?.destroy();
      req.destroy();
      reject(err);
    };

    const finishResolve = (result: HopResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finishReject(
        new ApiError(504, 'TIMEOUT', 'The request timed out while fetching the page')
      );
    }, Math.max(remainingTimeoutMs, 1));

    const pinnedAddress = connectAddress ?? target.address;
    const pinnedFamily: 4 | 6 = connectAddress ? 4 : target.family;

    const client = target.url.protocol === 'https:' ? https : http;
    const req = client.request(
      target.url,
      {
        method: 'GET',
        agent: false,
        lookup: createPinnedLookup(pinnedAddress, pinnedFamily),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'close',
          'Upgrade-Insecure-Requests': '1',
        },
      },
      (res) => {
        currentRes = res;
        const statusCode = res.statusCode ?? 0;

        if (REDIRECT_STATUS_CODES.has(statusCode)) {
          const locationHeader = res.headers.location;
          res.resume();
          if (typeof locationHeader !== 'string' || !locationHeader.trim()) {
            finishReject(
              new ApiError(
                502,
                'FETCH_ERROR',
                'Redirect response is missing a valid Location header'
              )
            );
            return;
          }

          let nextUrl: URL;
          try {
            nextUrl = new URL(locationHeader, target.url);
          } catch {
            finishReject(
              new ApiError(
                502,
                'FETCH_ERROR',
                'Redirect response contains an invalid Location URL'
              )
            );
            return;
          }

          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
            finishReject(
              new ApiError(
                403,
                'SSRF_BLOCKED',
                'Redirect target protocol is not allowed'
              )
            );
            return;
          }

          finishResolve({ kind: 'redirect', nextUrl });
          return;
        }

        if (statusCode === 404) {
          res.resume();
          finishReject(
            new ApiError(404, 'PAGE_NOT_FOUND', 'The requested page was not found')
          );
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          finishReject(
            new ApiError(502, 'FETCH_ERROR', 'Failed to fetch the requested page')
          );
          return;
        }

        if (!isHtmlContentType(res.headers['content-type'])) {
          finishReject(
            new ApiError(
              415,
              'UNSUPPORTED_MEDIA_TYPE',
              'Fetched content is not HTML'
            )
          );
          return;
        }

        const contentLengthHeader = res.headers['content-length'];
        if (typeof contentLengthHeader === 'string' && /^\d+$/.test(contentLengthHeader.trim())) {
          const declaredBytes = Number.parseInt(contentLengthHeader.trim(), 10);
          if (declaredBytes > maxBytes) {
            finishReject(
              new ApiError(
                413,
                'PAGE_TOO_LARGE',
                'Page exceeds the 2MB size limit for free tier'
              )
            );
            return;
          }
        }

        decodedStream = createDecodedStream(res);
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on('error', () => {
          finishReject(
            new ApiError(502, 'FETCH_ERROR', 'Failed to read response from target page')
          );
        });

        decodedStream.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
          totalBytes += buf.length;
          if (totalBytes > maxBytes) {
            finishReject(
              new ApiError(
                413,
                'PAGE_TOO_LARGE',
                'Page exceeds the 2MB size limit for free tier'
              )
            );
            return;
          }
          chunks.push(buf);
        });

        decodedStream.on('end', () => {
          if (settled) {
            return;
          }
          const html = Buffer.concat(chunks, totalBytes).toString('utf8');
          finishResolve({
            kind: 'final',
            html,
            finalUrl: target.url.href,
            originalLength: totalBytes,
          });
        });

        decodedStream.on('error', () => {
          finishReject(
            new ApiError(502, 'FETCH_ERROR', 'Failed to decode response body')
          );
        });
      }
    );

    req.on('error', () => {
      finishReject(
        new ApiError(502, 'FETCH_ERROR', 'Failed to fetch the requested page')
      );
    });

    req.end();
  });
}

/**
 * Fetches an HTML document over HTTP/HTTPS with hop-by-hop SSRF validation,
 * per-hop DNS pinning, early Content-Type verification, and streaming decompressed
 * byte-limit enforcement.
 */
export async function safeFetchHtml(
  initialUrl: URL,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? MAX_CONTENT_LENGTH;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await resolveSafeTarget(currentUrl, options.lookupFn);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ApiError(
        504,
        'TIMEOUT',
        'The request timed out while fetching the page'
      );
    }

    const result = await executeHop(
      target,
      maxBytes,
      remainingMs,
      options.connectAddress
    );

    if (result.kind === 'final') {
      return {
        html: result.html,
        finalUrl: result.finalUrl,
        originalLength: result.originalLength,
      };
    }

    currentUrl = result.nextUrl;
  }

  throw new ApiError(502, 'FETCH_ERROR', 'Maximum redirect limit exceeded');
}
