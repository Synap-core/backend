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
  FacetProfileKindError,
  FacetKindMismatchError,
} from "@synap/database";
import {
  classifyThrownFailure,
  safeFailureSentence,
  safeApprovalError,
} from "../routers/proposals/failure-classification.js";

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
  if (error instanceof FacetProfileKindError) {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof FacetKindMismatchError) {
    return new TRPCError({
      code: "BAD_REQUEST",
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
    error instanceof PropertySlugConflictError ||
    error instanceof FacetProfileKindError ||
    error instanceof FacetKindMismatchError
  );
}

// ── Setup-required (capability-install) mapper ─────────────────────────────

/**
 * Convert a `SetupRequiredError` — or any duck-typed `isSetupRequiredLike`
 * carrier — into a CODED `TRPCError` whose `cause` still holds the structured
 * payload, so `init-trpc.ts`'s errorFormatter can forward
 * `failureClass` / `missingFields` / `connection` to the client.
 *
 * ## Why the code is not mapped here
 *
 * `SetupRequiredError` carries NO `.code`, so unchecked tRPC's own boundary
 * (`getTRPCErrorFromUnknown`) wraps it into an `INTERNAL_SERVER_ERROR` and the
 * actionable "connect Google / supply the API key" payload is dropped — the
 * browser's `error.data.failureClass` read is permanently absent. The
 * class→code mapping is NOT re-invented: it is reached through
 * `safeApprovalError` / `classifyThrownFailure`
 * (`routers/proposals/failure-classification.ts`), the SAME derivation the
 * proposal-approval path and the Hub REST `POST /capabilities/apply` door
 * (400/412 + body) use — so no two doors can disagree on the code
 * (`missing_field → BAD_REQUEST`, `no_connection → PRECONDITION_FAILED`).
 *
 * `safeFailureSentence` supplies the value-free, redacted sentence the thrower
 * already wrote (it names param LABELS, never values), so the message the
 * client sees matches the REST door's body and the stored `rejectionReason`.
 *
 * CALLER CONTRACT: only invoke this for an input that satisfies
 * `isSetupRequiredLike` — routing an unclassified error here would replace the
 * debugging message the unknown branch preserves with the generic safe
 * sentence. `errorCatchingMiddleware` guards it.
 */
export function mapSetupRequiredToTRPC(error: unknown): TRPCError {
  const meta = classifyThrownFailure(error);
  return safeApprovalError(
    error,
    meta,
    safeFailureSentence(error, meta)
  ) as TRPCError;
}
