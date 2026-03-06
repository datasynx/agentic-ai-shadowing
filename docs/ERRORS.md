# Error Codes Reference

All errors thrown by `@datasynx/agentic-ai-shadowing` use the `ShadowingError` class with a machine-readable `code` property.

```typescript
import { ShadowingError } from '@datasynx/agentic-ai-shadowing';

try {
  taskManager.startTask('My Task');
} catch (err) {
  if (err instanceof ShadowingError) {
    console.error(err.code);       // 'task_already_active'
    console.error(err.httpStatus);  // 422
    console.error(err.retryable);   // false
  }
}
```

---

## Task Errors

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `task_not_found` | 404 | No | Task ID does not exist in the database |
| `task_already_active` | 422 | No | Cannot start a new task while another is active |
| `task_not_active` | 422 | No | Operation requires an active task but the task has a different status |
| `task_not_paused` | 422 | No | Cannot resume a task that is not paused |
| `task_already_completed` | 422 | No | Cannot modify a completed task |
| `task_cancelled` | 422 | No | Cannot modify a cancelled task |
| `no_active_task` | 422 | No | Operation requires an active task but none exists |
| `no_paused_task` | 422 | No | Resume requested but no paused task exists |

## SOP Errors

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `sop_not_found` | 404 | No | SOP ID does not exist in the database |
| `sop_content_too_large` | 422 | No | SOP content exceeds the maximum allowed size |
| `invalid_status_transition` | 422 | No | Status change not allowed (e.g., archived → draft) |

## Database Errors

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `db_constraint_error` | 422 | No | SQLite constraint violation (unique, foreign key) |
| `session_not_found` | 404 | No | Observation session ID does not exist |

## Authentication & Authorization

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `unauthorized` | 401 | No | Missing or invalid Bearer token |

## Rate Limiting

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `rate_limited` | 429 | **Yes** | Too many requests — retry after backoff |

## Validation

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `validation_error` | 400 | No | Input validation failed (Zod schema or manual check) |

## API / SOP Generation Errors

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `missing_api_key` | 502 | No | `ANTHROPIC_API_KEY` environment variable not set |
| `auth_failed` | 502 | No | Anthropic API rejected the API key |
| `api_error` | 502 | **Yes** | Transient Anthropic API error (timeout, 5xx) |
| `parse_error` | 500 | No | Failed to parse Claude's response into expected format |
| `response_too_large` | 502 | No | API response exceeds 500KB safety limit |

## Generic

| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `unknown` | 500 | No | Unclassified error — check `message` and `cause` for details |

---

## Error Properties

```typescript
class ShadowingError extends Error {
  readonly code: ShadowingErrorCode;  // Machine-readable error code
  readonly meta?: Record<string, unknown>;  // Additional context
  get httpStatus(): number;  // Suggested HTTP status code
  get retryable(): boolean;  // Whether the operation can be retried
}
```

## SOPGenerationError (Legacy Compat)

```typescript
class SOPGenerationError extends ShadowingError {
  readonly statusCode?: number;  // Original Anthropic API status code
}
```

`SOPGenerationError` extends `ShadowingError` and can be caught with either type. It is exported from both `@datasynx/agentic-ai-shadowing` and `@datasynx/agentic-ai-shadowing/sop-generator` for backward compatibility.
