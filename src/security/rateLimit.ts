import type { VercelRequest } from '@vercel/node';
import {
  DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  MAX_RATE_LIMIT_ENTRIES,
  parseEnvInt,
} from '../config';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function extractFirstIp(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue !== 'string') {
    return null;
  }
  const first = headerValue.split(',')[0]?.trim();
  return first ? first : null;
}

/**
 * Extracts the client IP giving precedence to platform-verified headers
 * (`x-real-ip`, `x-vercel-forwarded-for`) before falling back to `x-forwarded-for`.
 */
export function getClientIp(req: VercelRequest): string {
  const realIp = extractFirstIp(req.headers['x-real-ip']);
  if (realIp) {
    return realIp;
  }

  const vercelForwarded = extractFirstIp(req.headers['x-vercel-forwarded-for']);
  if (vercelForwarded) {
    return vercelForwarded;
  }

  const forwarded = extractFirstIp(req.headers['x-forwarded-for']);
  if (forwarded) {
    return forwarded;
  }

  const remoteAddress = req.socket?.remoteAddress?.trim();
  if (remoteAddress) {
    return remoteAddress;
  }

  return 'unknown';
}

function evictExpired(now: number): void {
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

export function checkRateLimit(clientIp: string): RateLimitResult {
  const now = Date.now();
  const windowMs = parseEnvInt(
    process.env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    1
  );
  const limit = parseEnvInt(
    process.env.RATE_LIMIT_MAX,
    DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    0
  );

  evictExpired(now);

  let current = rateLimitStore.get(clientIp);
  if (!current) {
    if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimitStore.keys().next().value;
      if (oldestKey !== undefined) {
        rateLimitStore.delete(oldestKey);
      }
    }
    current = { count: 0, resetAt: now + windowMs };
    rateLimitStore.set(clientIp, current);
  }

  current.count += 1;
  const retryAfterSeconds = Math.max(Math.ceil((current.resetAt - now) / 1000), 1);

  return {
    allowed: current.count <= limit,
    remaining: Math.max(limit - current.count, 0),
    limit,
    retryAfterSeconds,
  };
}

export function resetRateLimitStore(): void {
  rateLimitStore.clear();
}

export function getRateLimitStoreSize(): number {
  return rateLimitStore.size;
}
