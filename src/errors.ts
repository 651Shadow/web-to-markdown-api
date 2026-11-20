import type { VercelResponse } from '@vercel/node';

export interface ErrorResponse {
  error: string;
  message: string;
  code: number;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  toResponse(): ErrorResponse {
    return {
      error: this.code,
      message: this.message,
      code: this.statusCode,
    };
  }
}

export function sendError(res: VercelResponse, error: ApiError): void {
  res.status(error.statusCode).json(error.toResponse());
}
