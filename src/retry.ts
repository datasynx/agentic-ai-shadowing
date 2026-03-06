import Anthropic from '@anthropic-ai/sdk';
import { SOPGenerationError } from './sop-generator.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIError && err.status >= 500) return true;
  if (err instanceof SOPGenerationError && err.retryable) return true;
  return false;
}

function getRetryAfterMs(err: unknown): number | null {
  if (err instanceof Anthropic.APIError) {
    const headers = err.headers;
    const retryAfter = headers?.['retry-after'];
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds)) return seconds * 1000;
    }
  }
  return null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_OPTIONS, ...opts };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !isRetryableError(err)) {
        throw err;
      }

      const retryAfterMs = getRetryAfterMs(err);
      const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const delay = retryAfterMs ?? exponentialDelay;

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
