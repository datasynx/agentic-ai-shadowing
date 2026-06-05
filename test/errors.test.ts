import { describe, it, expect } from 'vitest';
import { ShadowingError, SOPGenerationError } from '../src/errors.js';

describe('ShadowingError', () => {
  it('creates error with code and message', () => {
    const err = new ShadowingError('Task not found', 'task_not_found');
    expect(err.message).toBe('Task not found');
    expect(err.code).toBe('task_not_found');
    expect(err.name).toBe('ShadowingError');
    expect(err).toBeInstanceOf(Error);
  });

  it('includes metadata', () => {
    const err = new ShadowingError('Not found', 'sop_not_found', { sopId: 'abc123' });
    expect(err.meta).toEqual({ sopId: 'abc123' });
  });

  it('supports error cause', () => {
    const cause = new Error('original');
    const err = new ShadowingError('Wrapped', 'unknown', undefined, { cause });
    expect(err.cause).toBe(cause);
  });

  it('returns correct HTTP status for task_not_found', () => {
    const err = new ShadowingError('Not found', 'task_not_found');
    expect(err.httpStatus).toBe(404);
  });

  it('returns correct HTTP status for sop_not_found', () => {
    expect(new ShadowingError('', 'sop_not_found').httpStatus).toBe(404);
  });

  it('returns 422 for task_already_active', () => {
    expect(new ShadowingError('', 'task_already_active').httpStatus).toBe(422);
  });

  it('returns 422 for no_active_task', () => {
    expect(new ShadowingError('', 'no_active_task').httpStatus).toBe(422);
  });

  it('returns 401 for unauthorized', () => {
    expect(new ShadowingError('', 'unauthorized').httpStatus).toBe(401);
  });

  it('returns 429 for rate_limited', () => {
    expect(new ShadowingError('', 'rate_limited').httpStatus).toBe(429);
  });

  it('returns 400 for validation_error', () => {
    expect(new ShadowingError('', 'validation_error').httpStatus).toBe(400);
  });

  it('returns 502 for api_error', () => {
    expect(new ShadowingError('', 'api_error').httpStatus).toBe(502);
  });

  it('returns 500 for unknown', () => {
    expect(new ShadowingError('', 'unknown').httpStatus).toBe(500);
  });

  it('retryable is true for rate_limited', () => {
    expect(new ShadowingError('', 'rate_limited').retryable).toBe(true);
  });

  it('retryable is true for api_error', () => {
    expect(new ShadowingError('', 'api_error').retryable).toBe(true);
  });

  it('retryable is false for task_not_found', () => {
    expect(new ShadowingError('', 'task_not_found').retryable).toBe(false);
  });
});

describe('SOPGenerationError', () => {
  it('extends ShadowingError', () => {
    const err = new SOPGenerationError('API failed', 'api_error', true, 500);
    expect(err).toBeInstanceOf(ShadowingError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SOPGenerationError');
  });

  it('preserves statusCode', () => {
    const err = new SOPGenerationError('Rate limited', 'rate_limited', true, 429);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('rate_limited');
  });

  it('works without statusCode', () => {
    const err = new SOPGenerationError('Missing key', 'missing_api_key', false);
    expect(err.statusCode).toBeUndefined();
  });
});
