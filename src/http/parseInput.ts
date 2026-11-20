import type { VercelRequest } from '@vercel/node';
import { MAX_CONTENT_LENGTH } from '../config';
import { ApiError } from '../errors';
import { validateUrl } from '../security/ssrf';

export type ConversionInput =
  | { source: 'html'; html: string; baseUrl?: URL }
  | { source: 'url'; url: URL };

export interface ResolvedDocument {
  source: 'html' | 'url';
  url: string | null;
  html: string;
  originalLength: number;
}

const MISSING_INPUT_MESSAGE =
  'Provide a "url" parameter to fetch, an "html" field with raw HTML, or POST an HTML document with Content-Type: text/html';

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_INPUT', `The "${label}" field must be a single string`);
  }
  return value;
}

function parseOptionalBaseUrl(rawBaseUrl: unknown): URL | undefined {
  const baseStr = readOptionalString(rawBaseUrl, 'base_url');
  if (baseStr === undefined) {
    return undefined;
  }
  const trimmed = baseStr.trim();
  const validated = trimmed ? validateUrl(trimmed) : null;
  if (!validated) {
    throw new ApiError(
      400,
      'INVALID_BASE_URL',
      'The "base_url" must be a valid HTTP or HTTPS URL'
    );
  }
  return validated;
}

function buildHtmlInput(rawHtml: unknown, rawBaseUrl: unknown): ConversionInput {
  const html = readOptionalString(rawHtml, 'html');
  if (html === undefined) {
    throw new ApiError(400, 'MISSING_INPUT', MISSING_INPUT_MESSAGE);
  }

  if (html.trim() === '') {
    throw new ApiError(400, 'EMPTY_HTML', 'The provided HTML content is empty');
  }

  if (Buffer.byteLength(html, 'utf8') > MAX_CONTENT_LENGTH) {
    throw new ApiError(
      413,
      'PAGE_TOO_LARGE',
      'HTML exceeds the 2MB size limit for free tier'
    );
  }

  const baseUrl = parseOptionalBaseUrl(rawBaseUrl);
  return {
    source: 'html',
    html,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function buildUrlInput(rawUrl: unknown): ConversionInput {
  const urlStr = readOptionalString(rawUrl, 'url');
  if (urlStr === undefined) {
    throw new ApiError(400, 'MISSING_INPUT', MISSING_INPUT_MESSAGE);
  }

  const trimmed = urlStr.trim();
  const validated = trimmed ? validateUrl(trimmed) : null;
  if (!validated) {
    throw new ApiError(
      400,
      'INVALID_URL',
      'The provided URL is not valid. Must be a valid HTTP or HTTPS URL.'
    );
  }

  return {
    source: 'url',
    url: validated,
  };
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || body === '') {
    return {};
  }
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(400, 'INVALID_INPUT', 'Malformed JSON request body');
    }
  }
  if (typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    return body as Record<string, unknown>;
  }
  throw new ApiError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
}

/**
 * Extracts and validates the request input into a discriminated `ConversionInput` union.
 */
export function parseInput(req: VercelRequest): ConversionInput {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const queryUrl = readOptionalString(query.url, 'url');
  const queryBaseUrl = readOptionalString(query.base_url, 'base_url');

  if (req.method === 'GET') {
    return buildUrlInput(queryUrl);
  }

  const rawContentType = req.headers['content-type'];
  const contentType = (typeof rawContentType === 'string' ? rawContentType : '').toLowerCase();

  if (contentType.includes('text/html') || contentType.includes('text/plain')) {
    if (req.body === undefined || req.body === null) {
      throw new ApiError(400, 'MISSING_INPUT', MISSING_INPUT_MESSAGE);
    }
    const bodyHtml = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    return buildHtmlInput(bodyHtml, queryBaseUrl);
  }

  const bodyObj = parseJsonBody(req.body);
  const rawHtml = bodyObj.html;
  const rawUrl = bodyObj.url !== undefined ? bodyObj.url : queryUrl;
  const rawBaseUrl = bodyObj.base_url !== undefined ? bodyObj.base_url : queryBaseUrl;

  if (rawHtml === undefined && rawUrl === undefined) {
    throw new ApiError(400, 'MISSING_INPUT', MISSING_INPUT_MESSAGE);
  }

  if (rawHtml !== undefined && rawUrl !== undefined) {
    throw new ApiError(400, 'INVALID_INPUT', 'Provide either "url" or "html", not both');
  }

  return rawHtml !== undefined
    ? buildHtmlInput(rawHtml, rawBaseUrl)
    : buildUrlInput(rawUrl);
}
