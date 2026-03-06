// ── Error Codes ─────────────────────────────────────────────────────────────

export type ShadowingErrorCode =
  // Task errors
  | 'task_not_found'
  | 'task_already_active'
  | 'task_not_active'
  | 'task_not_paused'
  | 'task_already_completed'
  | 'task_cancelled'
  | 'no_active_task'
  | 'no_paused_task'
  // SOP errors
  | 'sop_not_found'
  | 'sop_content_too_large'
  | 'invalid_status_transition'
  // DB errors
  | 'db_constraint_error'
  | 'session_not_found'
  // Auth errors
  | 'unauthorized'
  // Rate limit
  | 'rate_limited'
  // Validation
  | 'validation_error'
  // API errors (SOP generation)
  | 'missing_api_key'
  | 'auth_failed'
  | 'api_error'
  | 'parse_error'
  | 'response_too_large'
  // Generic
  | 'unknown';

export class ShadowingError extends Error {
  constructor(
    message: string,
    public readonly code: ShadowingErrorCode,
    public readonly meta?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ShadowingError';
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'api_error';
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'validation_error': return 400;
      case 'unauthorized': return 401;
      case 'task_not_found':
      case 'sop_not_found':
      case 'session_not_found':
        return 404;
      case 'rate_limited': return 429;
      case 'task_already_active':
      case 'task_not_active':
      case 'task_not_paused':
      case 'task_already_completed':
      case 'task_cancelled':
      case 'no_active_task':
      case 'no_paused_task':
      case 'invalid_status_transition':
      case 'sop_content_too_large':
      case 'db_constraint_error':
        return 422;
      case 'missing_api_key':
      case 'auth_failed':
        return 502;
      case 'api_error':
      case 'response_too_large':
        return 502;
      case 'parse_error':
      case 'unknown':
      default:
        return 500;
    }
  }
}

/** Backward-compatible alias for SOPGenerationError. */
export class SOPGenerationError extends ShadowingError {
  constructor(
    message: string,
    code: 'missing_api_key' | 'auth_failed' | 'rate_limited' | 'api_error' | 'parse_error' | 'response_too_large' | 'unknown',
    retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(message, code, statusCode ? { statusCode } : undefined);
    this.name = 'SOPGenerationError';
    // retryable is now derived from code via parent, but kept for compat
    void retryable;
  }
}
