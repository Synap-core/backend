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

/** What a move targets: a kind's own lifecycle, or a role's (on its facet). */
export type MoveStatusSubject =
  /** `property` is the declared lifecycle slug (`lifecycle.get().property`). */
  | { kind: "kind"; entityId: string; property: string }
  /** A role's lifecycle, stored on the facet (`facetId`). */
  | { kind: "role"; entityId: string; facetId: string };

export interface MoveStatusArgs {
  subject: MoveStatusSubject;
  /** The target option key. */
  to: string;
  /** The status the caller SAW — never omitted: a move is compare-and-set. */
  from: string | null;
  /** Why, when a person said so (recorded on the transition). */
  reason?: string;
}

/** Which door a move calls, with what (tRPC `entities.update` / `entities.updateFacet`). */
export type MoveStatusRequest =
  | {
      door: "update";
      input: {
        id: string;
        properties: Record<string, unknown>;
        expectedStatus: string | null;
        reasoning?: string;
      };
    }
  | {
      door: "updateFacet";
      input: {
        facetId: string;
        status: string;
        expectedStatus: string | null;
        reasoning?: string;
      };
    };

/**
 * The ONE subject → request mapping (web `useMoveStatus`, relay's mover).
 * Compare-and-set ALWAYS: `expectedStatus` is sent even when the reader saw
 * no status (`null`), so a thing that moved meanwhile is refused (CONFLICT),
 * never silently overwritten.
 */
export function moveRequest(args: MoveStatusArgs): MoveStatusRequest {
  const reasoning = args.reason ? { reasoning: args.reason } : {};
  return args.subject.kind === "kind"
    ? {
        door: "update",
        input: {
          id: args.subject.entityId,
          properties: { [args.subject.property]: args.to },
          expectedStatus: args.from,
          ...reasoning,
        },
      }
    : {
        door: "updateFacet",
        input: {
          facetId: args.subject.facetId,
          status: args.to,
          expectedStatus: args.from,
          ...reasoning,
        },
      };
}

/**
 * The move that takes a MOVED thing back (the web "Undo"): to where it was,
 * compare-and-set on where it went — so an undo after someone else moved it
 * again is refused, never a silent overwrite. Null when there is nowhere to
 * go back to (it had no status, or did not change).
 */
export function undoMoveOf(
  args: Pick<MoveStatusArgs, "subject" | "to" | "from">
): MoveStatusArgs | null {
  if (args.from == null || args.from === args.to) return null;
  return { subject: args.subject, to: args.from, from: args.to };
}

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
