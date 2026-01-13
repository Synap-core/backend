/**
 * Standardized Error Types
 *
 * Provides consistent error handling across frontend and backend.
 * All domain errors should extend these base classes.
 *
 * @example
 * ```typescript
 * import { NotFoundError, ValidationError } from '@synap-core/types/errors';
 *
 * if (!entity) {
 *   throw new NotFoundError('Entity', entityId);
 * }
 * ```
 */

/**
 * Base error class for all Synap errors
 *
 * Provides consistent error structure with:
 * - Error code for programmatic handling
 * - HTTP status code for API responses
 * - Optional context for debugging
 */
export class SynapError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SynapError";
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }

  /**
   * Convert error to JSON for API responses
   */
  toJSON(): {
    error: string;
    code: string;
    message: string;
    context?: Record<string, unknown>;
  } {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      ...(this.context && { context: this.context }),
    };
  }
}

/**
 * Validation error (400 Bad Request)
 *
 * Thrown when input validation fails.
 *
 * @example
 * ```typescript
 * if (!isValidEmail(email)) {
 *   throw new ValidationError('Invalid email format');
 * }
 * ```
 */
export class ValidationError extends SynapError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, context);
    this.name = "ValidationError";
  }
}

/**
 * Not found error (404 Not Found)
 *
 * Thrown when a requested resource doesn't exist.
 *
 * @example
 * ```typescript
 * const entity = await findEntity(id);
 * if (!entity) {
 *   throw new NotFoundError('Entity', id);
 * }
 * ```
 */
export class NotFoundError extends SynapError {
  constructor(
    resource: string,
    id?: string,
    context?: Record<string, unknown>,
  ) {
    const message = id
      ? `${resource} with id "${id}" not found`
      : `${resource} not found`;
    super(message, "NOT_FOUND", 404, { resource, id, ...context });
    this.name = "NotFoundError";
  }
}

/**
 * Unauthorized error (401 Unauthorized)
 *
 * Thrown when authentication is required but missing or invalid.
 *
 * @example
 * ```typescript
 * if (!isAuthenticated) {
 *   throw new UnauthorizedError('Authentication required');
 * }
 * ```
 */
export class UnauthorizedError extends SynapError {
  constructor(
    message: string = "Authentication required",
    context?: Record<string, unknown>,
  ) {
    super(message, "UNAUTHORIZED", 401, context);
    this.name = "UnauthorizedError";
  }
}

/**
 * Forbidden error (403 Forbidden)
 *
 * Thrown when user is authenticated but lacks permission.
 *
 * @example
 * ```typescript
 * if (!hasPermission(user, 'delete', entity)) {
 *   throw new ForbiddenError('Insufficient permissions');
 * }
 * ```
 */
export class ForbiddenError extends SynapError {
  constructor(
    message: string = "Insufficient permissions",
    context?: Record<string, unknown>,
  ) {
    super(message, "FORBIDDEN", 403, context);
    this.name = "ForbiddenError";
  }
}

/**
 * Conflict error (409 Conflict)
 *
 * Thrown when operation conflicts with current state.
 *
 * @example
 * ```typescript
 * if (entity.version !== expectedVersion) {
 *   throw new ConflictError('Entity version mismatch', { entityId, expectedVersion, actualVersion: entity.version });
 * }
 * ```
 */
export class ConflictError extends SynapError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFLICT", 409, context);
    this.name = "ConflictError";
  }
}

/**
 * Rate limit error (429 Too Many Requests)
 *
 * Thrown when rate limit is exceeded.
 *
 * @example
 * ```typescript
 * if (requestCount > limit) {
 *   throw new RateLimitError('Rate limit exceeded', { limit, retryAfter: 60 });
 * }
 * ```
 */
export class RateLimitError extends SynapError {
  constructor(
    message: string = "Rate limit exceeded",
    retryAfter?: number,
    context?: Record<string, unknown>,
  ) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, { retryAfter, ...context });
    this.name = "RateLimitError";
  }
}

/**
 * Internal server error (500 Internal Server Error)
 *
 * Thrown for unexpected server errors.
 * Should not be thrown directly; use specific error types when possible.
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   throw new InternalServerError('Operation failed', { originalError: error.message });
 * }
 * ```
 */
export class InternalServerError extends SynapError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "INTERNAL_SERVER_ERROR", 500, context);
    this.name = "InternalServerError";
  }
}

/**
 * Service unavailable error (503 Service Unavailable)
 *
 * Thrown when external service is unavailable.
 *
 * @example
 * ```typescript
 * if (!isServiceAvailable) {
 *   throw new ServiceUnavailableError('AI service is temporarily unavailable');
 * }
 * ```
 */
export class ServiceUnavailableError extends SynapError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "SERVICE_UNAVAILABLE", 503, context);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Check if error is a SynapError instance
 */
export function isSynapError(error: unknown): error is SynapError {
  return error instanceof SynapError;
}

/**
 * Convert unknown error to SynapError
 *
 * Useful for error handling where error type is unknown.
 *
 * @example
 * ```typescript
 * try {
 *   await operation();
 * } catch (error) {
 *   throw toSynapError(error, 'Operation failed');
 * }
 * ```
 */
export function toSynapError(
  error: unknown,
  defaultMessage: string = "An error occurred",
): SynapError {
  if (isSynapError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalServerError(defaultMessage, {
      originalError: error.message,
      stack: error.stack,
    });
  }

  return new InternalServerError(defaultMessage, {
    originalError: String(error),
  });
}
