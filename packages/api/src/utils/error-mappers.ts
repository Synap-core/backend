/**
 * Error Mapping Utilities
 *
 * Converts domain-layer and service-layer exceptions into tRPC errors
 * so callers always receive well-typed HTTP semantics.
 *
 * Usage (automatic via errorCatchingMiddleware in trpc.ts):
 *   All procedures are already wrapped — no manual catch needed.
 *
 * Usage (manual, when you need to call a repository outside a procedure):
 *   try {
 *     return await entityRepo.create(input);
 *   } catch (err) {
 *     throw mapDbErrorToTRPC(err);
 *   }
 */

import { TRPCError } from "@trpc/server";
import {
  ProfileNotFoundError,
  PropertyValidationError,
  PropertyDefinitionNotFoundError,
  InheritanceCycleError,
  ProfileSlugConflictError,
  PropertySlugConflictError,
} from "@synap/database";

// ── HTTP → tRPC code table ─────────────────────────────────────────────────

const HTTP_TO_TRPC: Record<number, TRPCError["code"]> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_SUPPORTED",
  408: "TIMEOUT",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
  499: "CLIENT_CLOSED_REQUEST",
  500: "INTERNAL_SERVER_ERROR",
  501: "NOT_IMPLEMENTED",
  503: "INTERNAL_SERVER_ERROR",
};

/**
 * Map an HTTP status code to the corresponding tRPC error code.
 */
export function statusCodeToTRPCCode(statusCode: number): TRPCError["code"] {
  return HTTP_TO_TRPC[statusCode] ?? "INTERNAL_SERVER_ERROR";
}

// ── SynapError duck-type guard ─────────────────────────────────────────────

/**
 * Works for SynapError from BOTH @synap-core/core and @synap-core/types,
 * avoiding cross-package instanceof failures.
 */
export function isSynapLikeError(
  error: unknown
): error is { code: string; statusCode: number; message: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  );
}

// ── Database domain error mapper ───────────────────────────────────────────

/**
 * Convert @synap/database domain exceptions to TRPCError.
 *
 * Database repositories throw typed exceptions (ProfileNotFoundError, etc.)
 * which have no HTTP semantics. This mapper bridges them to the correct
 * tRPC error codes before they reach the client.
 */
export function mapDbErrorToTRPC(error: unknown): TRPCError {
  if (error instanceof ProfileNotFoundError) {
    return new TRPCError({
      code: "NOT_FOUND",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof PropertyValidationError) {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof PropertyDefinitionNotFoundError) {
    return new TRPCError({
      code: "NOT_FOUND",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof InheritanceCycleError) {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof ProfileSlugConflictError) {
    return new TRPCError({
      code: "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof PropertySlugConflictError) {
    return new TRPCError({
      code: "CONFLICT",
      message: error.message,
      cause: error,
    });
  }

  // Unknown database error
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Database operation failed",
    cause: error,
  });
}

/**
 * True for any error class exported from @synap/database/errors.
 */
export function isDbDomainError(error: unknown): error is Error {
  return (
    error instanceof ProfileNotFoundError ||
    error instanceof PropertyValidationError ||
    error instanceof PropertyDefinitionNotFoundError ||
    error instanceof InheritanceCycleError ||
    error instanceof ProfileSlugConflictError ||
    error instanceof PropertySlugConflictError
  );
}
