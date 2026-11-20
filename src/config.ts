export const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_REDIRECTS = 5;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 30;
export const MAX_RATE_LIMIT_ENTRIES = 10_000;

/**
 * Safely parses a non-negative integer from an environment variable string.
 * Honors explicit `0` (when `min <= 0`) and falls back on empty, negative,
 * non-numeric, or out-of-range values instead of producing `NaN`.
 */
export function parseEnvInt(
  raw: string | undefined,
  fallback: number,
  min = 0
): number {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}
