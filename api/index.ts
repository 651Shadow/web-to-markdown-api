import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ApiError, sendError } from '../src/errors';
import { safeFetchHtml, type SafeFetchOptions } from '../src/fetch/safeFetch';
import {
  parseInput,
  type ConversionInput,
  type ResolvedDocument,
} from '../src/http/parseInput';
import { convertDocument } from '../src/pipeline/toMarkdown';
import { validateAuth } from '../src/security/auth';
import { checkRateLimit, getClientIp } from '../src/security/rateLimit';

async function resolveDocument(
  input: ConversionInput,
  fetchOptions?: SafeFetchOptions
): Promise<ResolvedDocument> {
  if (input.source === 'html') {
    return {
      source: 'html',
      url: input.baseUrl?.href ?? null,
      html: input.html,
      originalLength: Buffer.byteLength(input.html, 'utf8'),
    };
  }

  const fetched = await safeFetchHtml(input.url, fetchOptions);
  return {
    source: 'url',
    url: fetched.finalUrl,
    html: fetched.html,
    originalLength: fetched.originalLength,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
  fetchOptions?: SafeFetchOptions
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-rapidapi-proxy-secret, x-admin-key'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      throw new ApiError(
        405,
        'METHOD_NOT_ALLOWED',
        'Only GET and POST methods are supported'
      );
    }

    validateAuth(req);

    const rateLimit = checkRateLimit(getClientIp(req));
    res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
    res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
    res.setHeader('X-RateLimit-Reset', String(rateLimit.retryAfterSeconds));

    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many requests. Please try again later.'
      );
    }

    const input = parseInput(req);
    const document = await resolveDocument(input, fetchOptions);
    const response = convertDocument(document);

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof ApiError) {
      sendError(res, error);
      return;
    }
    sendError(
      res,
      new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred')
    );
  }
}
