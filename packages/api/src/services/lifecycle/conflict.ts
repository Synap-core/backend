/**
 * A STALE status move, as an agent door answers it (work model L2, E2).
 *
 * `moveStatus` is compare-and-set: a caller that says which status it SAW
 * (`expectedStatus`) and finds the thing moved meanwhile gets a conflict, and
 * nothing is written. The tRPC doors (`entities.update`, `entities.updateFacet`)
 * throw it as `CONFLICT` with a `LifecycleConflictError` cause; the agent doors
 * (hub `updateEntity` / `updateFacet`, Hub REST, MCP `synap_update_entity`)
 * turn it into THIS result — data an agent re-plans on (read the current
 * status, decide again), never a 500 and never an overwrite.
 */
import { TRPCError } from "@trpc/server";
import { LifecycleConflictError } from "@synap/database";

export interface LifecycleConflictResult {
  status: "conflict";
  conflict: {
    reason: "lifecycle_stale";
    /** The status the caller said it saw. */
    expectedStatus: string | null;
    /** The status the thing is in now — re-plan from this. */
    currentStatus: string | null;
  };
  message: string;
}

/** The CONFLICT a tRPC status door throws for a stale move. */
export function lifecycleConflictError(
  expectedFrom: string | null,
  actual: string | null
): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: `Stale status: expected "${expectedFrom ?? "none"}", it is now "${actual ?? "none"}". Nothing was changed.`,
    cause: new LifecycleConflictError(expectedFrom, actual),
  });
}

/**
 * The typed conflict inside an error a status door threw, or null. Duck-typed
 * on the cause's `code`: the error crosses package builds (src vs dist), where
 * `instanceof` can lie.
 */
export function lifecycleConflictOf(
  err: unknown
): LifecycleConflictResult | null {
  if (!(err instanceof Error)) return null;
  const cause = (err as { cause?: unknown }).cause as
    { code?: unknown; expectedFrom?: unknown; actual?: unknown } | undefined;
  if (!cause || cause.code !== "LIFECYCLE_STALE") return null;
  const expectedStatus =
    typeof cause.expectedFrom === "string" ? cause.expectedFrom : null;
  const currentStatus = typeof cause.actual === "string" ? cause.actual : null;
  return {
    status: "conflict",
    conflict: { reason: "lifecycle_stale", expectedStatus, currentStatus },
    message: `The status moved meanwhile: you expected "${expectedStatus ?? "none"}", it is now "${currentStatus ?? "none"}". Nothing was changed — re-read it and decide again.`,
  };
}
