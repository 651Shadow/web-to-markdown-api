import { createHash, timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import { ApiError } from '../errors';

function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Validates incoming request authentication headers in constant time.
 * Throws an `ApiError` (503 `AUTH_NOT_CONFIGURED` or 403 `FORBIDDEN`) when unauthorized.
 */
export function validateAuth(req: VercelRequest): void {
  const rapidApiSecret = process.env.RAPIDAPI_SECRET || undefined;
  const adminSecret = process.env.ADMIN_SECRET || undefined;
  const allowUnauthenticatedDev = process.env.ALLOW_UNAUTHENTICATED_DEV === 'true';

  const rapidApiHeader = getSingleHeader(req.headers['x-rapidapi-proxy-secret']);
  const adminHeader = getSingleHeader(req.headers['x-admin-key']);

  if (rapidApiSecret && rapidApiHeader && safeEqual(rapidApiHeader, rapidApiSecret)) {
    return;
  }

  if (adminSecret && adminHeader && safeEqual(adminHeader, adminSecret)) {
    return;
  }

  if (!rapidApiSecret && !adminSecret) {
    if (allowUnauthenticatedDev) {
      return;
    }

    throw new ApiError(
      503,
      'AUTH_NOT_CONFIGURED',
      'Server authentication is not configured. Set RAPIDAPI_SECRET or ADMIN_SECRET, or ALLOW_UNAUTHENTICATED_DEV=true for local-only testing.'
    );
  }

  throw new ApiError(
    403,
    'FORBIDDEN',
    'Invalid or missing authentication credentials'
  );
}
