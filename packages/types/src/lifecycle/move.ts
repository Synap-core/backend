/**
 * What a STATUS MOVE answered, read the same way on every surface (work model
 * L2/L3). The doors are `entities.update` (a kind's lifecycle key in
 * `properties`) and `entities.updateFacet` (a role's `status`), both through
 * the pod's one `moveStatus` door, both compare-and-set on `expectedStatus`.
 *
 * Web reads it in `useMoveStatus` (`@synap-core/hooks`); relay mirrors the
 * hook over the same three functions. No surface parses an error message.
 */
import type { UnitTone } from "../units/state.js";
import { resolveStatusLabel } from "../vocabulary/index.js";

export type MoveStatusOutcome =
  /** The status moved. */
  | { status: "moved" }
  /** Governed: a proposal waits for review; nothing moved yet. */
  | { status: "proposed"; proposalId: string | null }
  /**
   * Stale: the thing moved meanwhile (the status the caller saw is not the
   * one it has). Nothing was written. `currentStatus` is where it is now,
   * when the pod named it.
   */
  | { status: "conflict"; currentStatus: string | null }
  /** The pod refused the move (an unknown option, not this lifecycle…). */
  | { status: "refused"; message: string }
  /** The caller may not move it (a person-only status, no write grant…). */
  | { status: "denied"; message: string }
  /** Anything else — the network, a server fault. */
  | { status: "failed"; message: string };

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A RESOLVED door result (`{ status: "updated" | "proposed", … }`) as an outcome. */
export function moveOutcomeOfResult(result: unknown): MoveStatusOutcome {
  const r = record(result);
  if (r?.status === "proposed") {
    return {
      status: "proposed",
      proposalId: typeof r.proposalId === "string" ? r.proposalId : null,
    };
  }
  if (r?.status === "updated") return { status: "moved" };
  return {
    status: "failed",
    message:
      typeof r?.message === "string" && r.message
        ? r.message
        : "The move answered something unexpected.",
  };
}

/**
 * A THROWN door error as an outcome. Reads the tRPC error's `data` (`code`,
 * and for a stale move `reasonCode: "LIFECYCLE_STALE"` + `currentStatus`),
 * duck-typed so a TRPCClientError and a plain object read the same.
 */
export function moveOutcomeOfError(error: unknown): MoveStatusOutcome {
  const e = record(error);
  const data = record(e?.data) ?? record(record(e?.shape)?.data);
  const message =
    typeof e?.message === "string" && e.message
      ? e.message
      : "The move did not go through.";
  switch (data?.code) {
    case "CONFLICT":
      return {
        status: "conflict",
        currentStatus:
          data.reasonCode === "LIFECYCLE_STALE" &&
          typeof data.currentStatus === "string"
            ? data.currentStatus
            : null,
      };
    case "BAD_REQUEST":
      return { status: "refused", message };
    case "FORBIDDEN":
      return { status: "denied", message };
    default:
      return { status: "failed", message };
  }
}

/**
 * The one line a surface shows after a move (a toast, a banner), or null when
 * the move needs no words (it moved: the board already shows it). `labelOf`
 * gives the lifecycle's own words for a status key (`lifecycleOptionLabel`);
 * absent, the shared vocabulary speaks.
 */
export function moveOutcomeMessage(
  outcome: MoveStatusOutcome,
  labelOf?: (key: string) => string
): { tone: UnitTone; text: string } | null {
  switch (outcome.status) {
    case "moved":
      return null;
    case "proposed":
      return { tone: "info", text: "Sent for review" };
    case "conflict":
      return {
        tone: "warning",
        text: outcome.currentStatus
          ? `Moved meanwhile to ${(labelOf ?? resolveStatusLabel)(outcome.currentStatus)}`
          : "Moved meanwhile",
      };
    case "refused":
    case "denied":
    case "failed":
      return { tone: "error", text: outcome.message };
  }
}
