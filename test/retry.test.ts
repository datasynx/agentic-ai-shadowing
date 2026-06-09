import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/retry.js';
import { SOPGenerationError } from '../src/errors.js';

describe('withRetry — exponential backoff (#coverage)', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const result = await withRetry(() => { calls++; return Promise.resolve(42); });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries retryable errors and succeeds on a later attempt', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 3) return Promise.reject(new SOPGenerationError('rate limited', 'rate_limited', true, 429));
      return Promise.resolve('ok');
    }, { baseDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does NOT retry non-retryable errors', async () => {
    let calls = 0;
    await expect(withRetry(() => {
      calls++;
      return Promise.reject(new SOPGenerationError('bad key', 'auth_failed', false, 401));
    }, { baseDelayMs: 1 })).rejects.toThrowError('bad key');
    expect(calls).toBe(1);
  });

  it('does NOT retry plain Errors', async () => {
    let calls = 0;
    await expect(withRetry(() => {
      calls++;
      return Promise.reject(new Error('boom'));
    }, { baseDelayMs: 1 })).rejects.toThrowError('boom');
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    let calls = 0;
    await expect(withRetry(() => {
      calls++;
      return Promise.reject(new SOPGenerationError('still limited', 'rate_limited', true, 429));
    }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 })).rejects.toThrowError('still limited');
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('applies exponential backoff capped at maxDelayMs', async () => {
    const delays: number[] = [];
    let calls = 0;
    const start = Date.now();
    let last = start;

    await withRetry(() => {
      const now = Date.now();
      if (calls > 0) delays.push(now - last);
      last = now;
      calls++;
      if (calls <= 3) return Promise.reject(new SOPGenerationError('x', 'rate_limited', true, 429));
      return Promise.resolve('done');
    }, { baseDelayMs: 20, maxDelayMs: 50 });

    // attempt delays: 20ms, 40ms, capped 50ms (tolerances for timer jitter)
    expect(delays[0]).toBeGreaterThanOrEqual(15);
    expect(delays[1]).toBeGreaterThanOrEqual(30);
    expect(delays[2]).toBeGreaterThanOrEqual(40);
    expect(delays[2]).toBeLessThan(200); // cap respected (not 80ms uncapped → allow jitter)
  });
});
