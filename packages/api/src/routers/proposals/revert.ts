/**
 * Proposal revert planning — pure, DB-free decision of the inverse of an
 * approved proposal (extracted verbatim from proposals.ts, Wave 5
 * router-decomposition). Only `planProposalRevert` is imported outside this
 * module: by the `revert` router procedure and by `proposals-revert.test.ts`
 * (re-exported from the proposals.ts barrel).
 */

import type { MergeMaterializedStamp } from "@synap/database";
import { assertUnmergeable } from "@synap/database";
import type { StoredProposalData } from "@synap-core/types";
import {
  isRequestShapedProposalData,
  isCompositeProposalData,
} from "@synap-core/types/proposals";

// ---------------------------------------------------------------------------
// Revert planning (pure — no DB, fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * The concrete inverse a `revert` must apply. Either a list of soft-deletes /
 * deletes of the rows the proposal created, or `unsupported` with a loud reason.
 *
 * Effect verbs:
 *   - "delete-creations" → the proposal CREATED rows; the inverse is to delete
 *     them (entities/relations/documents the approval produced).
 *
 * Update/edit proposals carry no recoverable before-snapshot, so reverting them
 * is `unsupported` and the mutation FAILS LOUD rather than fabricating a state.
 *
 *   - "restore-delete" → the proposal DELETED an entity; entity deletes in this
 *     codebase are SOFT deletes (`entities.deletedAt`), so the inverse is to
 *     clear `deletedAt` — the row survives unless it was later hard-purged.
 */
export type ProposalRevertPlan =
  | {
      kind: "delete-creations";
      entityIds: string[];
      relationIds: string[];
      documentIds: string[];
    }
  | { kind: "restore-delete"; entityId: string }
  /**
   * Full entity-merge inverse: reverse signals/relations/links/facets and
   * restore both entities from pre-merge snapshots via `unmergeEntities`.
   */
  | {
      kind: "unmerge";
      winnerId: string;
      loserId: string;
    }
  | { kind: "unsupported"; reason: string };

/**
 * Minimal projection of a proposal row the planner needs. Keeps the planner
 * decoupled from drizzle's `$inferSelect` so it can be unit-tested with a
 * plain object.
 */
export interface RevertPlannerInput {
  status: string;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
}

/**
 * Decide the inverse of an approved proposal, reading ONLY the proposal's own
 * stored data — no schema change. The created ids come from:
 *   - `data.materialized.{entityIds,relationIds,documentIds}` — the canonical
 *     record the approve flow stamps (REQUIRED for inline-create + composite,
 *     whose ids are minted fresh and are otherwise unrecoverable);
 *   - falling back to `targetId` for the branches whose materialized id is the
 *     proposal target itself (generic `.validated` create where subjectId is the
 *     target; document create where documentId === targetId).
 *
 * Returns `unsupported` (→ fail loud) for update/edit proposals (no before-state)
 * and for anything we cannot positively map to created rows.
 */
export function planProposalRevert(
  proposal: RevertPlannerInput
): ProposalRevertPlan {
  const data =
    proposal.data && typeof proposal.data === "object"
      ? (proposal.data as StoredProposalData)
      : undefined;
  const materialized = data?.materialized;

  // Normalize the change kind. proposalType is a free string ("create",
  // "update", "edit", "delete", "create_branch", …) and request-shaped data
  // carries a `changeType`. Prefer changeType, fall back to proposalType.
  const changeType =
    (data && isRequestShapedProposalData(data) ? data.changeType : undefined) ??
    proposal.proposalType;
  const isCreate =
    proposal.proposalType === "create" ||
    changeType === "create" ||
    isCompositeProposalData(data ?? null);
  const isUpdate =
    !isCreate &&
    (proposal.proposalType === "update" ||
      proposal.proposalType === "edit" ||
      proposal.proposalType === "user_edit" ||
      changeType === "update");
  const isDelete =
    !isCreate &&
    !isUpdate &&
    (proposal.proposalType === "delete" || changeType === "delete");
  const isMerge =
    !isCreate &&
    !isUpdate &&
    !isDelete &&
    (proposal.proposalType === "merge" || changeType === "merge");

  // Update/edit: reverting needs the BEFORE-state, which is NOT persisted
  // anywhere on the row (the review enrich computes a before→after diff at read
  // time from the live entity, but the pre-approval snapshot is gone). Fail loud
  // rather than fabricate.
  if (isUpdate) {
    return {
      kind: "unsupported",
      reason:
        "Revert of an update/edit proposal is not supported without a before-snapshot (none is persisted on the proposal).",
    };
  }

  // Delete/archive: undoing a delete means RESTORING the target. Entity deletes
  // in this codebase are SOFT deletes (entities.ts sets `deletedAt`, the row
  // survives) — so an entity delete can be reverted by clearing `deletedAt`.
  // Whether the row is STILL restorable (not later hard-purged) is checked at
  // execution time in the `revert` mutation, since that requires a DB read.
  // Document/relation deletes are hard deletes today — no recoverable target.
  if (isDelete) {
    if (proposal.targetType === "entity" && proposal.targetId) {
      return { kind: "restore-delete", entityId: proposal.targetId };
    }
    return {
      kind: "unsupported",
      reason: `Revert of a '${proposal.targetType}' delete proposal is not supported: no recoverable soft-delete for this target type.`,
    };
  }

  // Entity merge: prefer FULL unmerge when invertibility stamp + snapshots are
  // present; fall back to soft-undelete of the loser for legacy stamps that
  // only recorded loserId (pre-B2 partial unmerge).
  if (isMerge) {
    const mergeStamp = materialized?.merge;
    const winnerId =
      (mergeStamp?.winnerId as string | undefined) ??
      (data &&
      typeof data === "object" &&
      typeof (data as { winnerId?: unknown }).winnerId === "string"
        ? ((data as { winnerId: string }).winnerId as string)
        : undefined);
    const loserId =
      (mergeStamp?.loserId as string | undefined) ??
      (data &&
      typeof data === "object" &&
      typeof (data as { loserId?: unknown }).loserId === "string"
        ? ((data as { loserId: string }).loserId as string)
        : undefined);

    const previousWinnerSnapshot =
      data &&
      typeof data === "object" &&
      (data as { previousWinnerSnapshot?: unknown }).previousWinnerSnapshot &&
      typeof (data as { previousWinnerSnapshot?: unknown })
        .previousWinnerSnapshot === "object"
        ? ((data as { previousWinnerSnapshot: unknown })
            .previousWinnerSnapshot as {
            title?: string | null;
            preview?: string | null;
            properties?: Record<string, unknown>;
            documentId?: string | null;
            systemData?: Record<string, unknown>;
          })
        : undefined;

    // Full unmerge when stamp has invertibility fields (rewiredRelations etc.).
    if (winnerId && loserId && previousWinnerSnapshot && mergeStamp) {
      try {
        assertUnmergeable({
          winnerId,
          loserId,
          previousWinnerSnapshot,
          materialized: mergeStamp as MergeMaterializedStamp,
        });
        return { kind: "unmerge", winnerId, loserId };
      } catch {
        // Incomplete stamp — fall through to legacy restore-delete if possible.
      }
    }

    if (loserId) {
      return { kind: "restore-delete", entityId: loserId };
    }
    return {
      kind: "unsupported",
      reason:
        "Revert of an entity merge requires materialized.merge.loserId (approve stamp missing).",
    };
  }

  if (isCreate) {
    const entityIds = [...(materialized?.entityIds ?? [])];
    const relationIds = [...(materialized?.relationIds ?? [])];
    const documentIds = [...(materialized?.documentIds ?? [])];

    // Fallback for branches whose created id IS the proposal target and which
    // therefore may not have stamped `materialized` (generic `.validated` entity
    // create; document create where documentId === targetId).
    if (
      entityIds.length === 0 &&
      relationIds.length === 0 &&
      documentIds.length === 0
    ) {
      if (proposal.targetType === "entity" && proposal.targetId) {
        entityIds.push(proposal.targetId);
      } else if (proposal.targetType === "document" && proposal.targetId) {
        documentIds.push(proposal.targetId);
      }
    }

    if (
      entityIds.length === 0 &&
      relationIds.length === 0 &&
      documentIds.length === 0
    ) {
      return {
        kind: "unsupported",
        reason: `Revert of a '${proposal.targetType}' create proposal is not supported: no materialized record of created rows.`,
      };
    }

    return { kind: "delete-creations", entityIds, relationIds, documentIds };
  }

  return {
    kind: "unsupported",
    reason: `Revert of proposal type '${proposal.targetType}/${proposal.proposalType}' is not supported.`,
  };
}
