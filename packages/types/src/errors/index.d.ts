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
export declare class SynapError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly context?: Record<string, unknown>;
    constructor(message: string, code: string, statusCode?: number, context?: Record<string, unknown>);
    /**
     * Convert error to JSON for API responses
     */
    toJSON(): {
        error: string;
        code: string;
        message: string;
        context?: Record<string, unknown>;
    };
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
export declare class ValidationError extends SynapError {
    constructor(message: string, context?: Record<string, unknown>);
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
export declare class NotFoundError extends SynapError {
    constructor(resource: string, id?: string, context?: Record<string, unknown>);
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
export declare class UnauthorizedError extends SynapError {
    constructor(message?: string, context?: Record<string, unknown>);
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
export declare class ForbiddenError extends SynapError {
    constructor(message?: string, context?: Record<string, unknown>);
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
export declare class ConflictError extends SynapError {
    constructor(message: string, context?: Record<string, unknown>);
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
export declare class RateLimitError extends SynapError {
    constructor(message?: string, retryAfter?: number, context?: Record<string, unknown>);
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
export declare class InternalServerError extends SynapError {
    constructor(message: string, context?: Record<string, unknown>);
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
export declare class ServiceUnavailableError extends SynapError {
    constructor(message: string, context?: Record<string, unknown>);
}
/**
 * Check if error is a SynapError instance
 */
export declare function isSynapError(error: unknown): error is SynapError;
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
export declare function toSynapError(error: unknown, defaultMessage?: string): SynapError;
//# sourceMappingURL=index.d.ts.map