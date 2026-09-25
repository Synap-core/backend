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
import type { CompleteMaterializedRecord } from "../../services/proposals/stamp-materialized.js";
import type { EntityPropertyDiff } from "../../utils/entity-property-diff.js";

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
 * Update/edit proposals: a propose-time before-snapshot IS captured and
 * persisted on the row (`captureEntityPreviousData`, permission-check.ts
 * :3304 / :3648) — this planner just doesn't consume it yet (no APPLY-time
 * snapshot exists for undo). Until that's wired up, reverting an update is
 * `unsupported` and the mutation FAILS LOUD rather than fabricating a state.
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
      /** Facets, config rows and merge overwrites — the complete record. */
      facetIds: string[];
      skillIds: string[];
      automationIds: string[];
      ruleIds: string[];
      propertyDiffs: EntityPropertyDiff[];
      /** Connected plan rows — optional so every older plan literal still types. */
      sessionIds?: string[];
      projectIds?: string[];
      linkIds?: string[];
      projectSubjectIds?: Record<string, string>;
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

  // Update/edit: a propose-time before-snapshot IS persisted on the row —
  // `captureEntityPreviousData` (permission-check.ts :3648) runs at propose
  // time and is stored into `RequestShapedProposalData.previousData`
  // (permission-check.ts :3304). What's actually missing is an APPLY-time
  // snapshot: this planner doesn't read the persisted `previousData` for
  // revert, and a propose-time snapshot alone can go stale if the entity was
  // edited again between propose and approve. Wiring an apply-time snapshot
  // into this planner is a planned change awaiting the founder — until then,
  // fail loud rather than revert against a snapshot that may not match what
  // the approval actually applied.
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
    const plan = creationsPlanFromRecord(
      (materialized ?? {}) as CompleteMaterializedRecord
    );
    const isEmpty = () =>
      plan.entityIds.length === 0 &&
      plan.relationIds.length === 0 &&
      plan.documentIds.length === 0 &&
      plan.facetIds.length === 0 &&
      plan.skillIds.length === 0 &&
      plan.automationIds.length === 0 &&
      plan.ruleIds.length === 0 &&
      plan.propertyDiffs.length === 0 &&
      (plan.sessionIds?.length ?? 0) === 0 &&
      (plan.projectIds?.length ?? 0) === 0 &&
      (plan.linkIds?.length ?? 0) === 0;

    // Fallback for LEGACY branches whose created id IS the proposal target and
    // which never stamped `materialized` at all (generic `.validated` entity
    // create; document create where documentId === targetId).
    //
    // ABSENT ONLY — never present-but-empty. `materialized: {}` is not "no
    // record", it is the executor SAYING it created nothing: `entity/create`
    // stamps exactly that when the create DEDUPED onto a pre-existing entity
    // ("revert can never delete a row this proposal did not create" —
    // `executors/entity.ts`). Re-adding the pre-minted `targetId` there made
    // `revertable` true both before AND after approval, and the real revert
    // then deleted an id that was never created → NOT_FOUND → "Revert failed".
    // An explicit empty record must fail LOUD (`unsupported`), which is the
    // same stance the composite branch below already takes.
    //
    // NEVER for a composite graph: its `targetId` is a placeholder minted at
    // propose time, not a created row. Falling back to it is how an import
    // with no record reverted by deleting a random id → NOT_FOUND → "Revert
    // failed". A graph with no record says so instead.
    const stampedNothing = materialized !== undefined;
    if (
      isEmpty() &&
      !stampedNothing &&
      !isCompositeProposalData(data ?? null)
    ) {
      if (proposal.targetType === "entity" && proposal.targetId) {
        plan.entityIds.push(proposal.targetId);
      } else if (proposal.targetType === "document" && proposal.targetId) {
        plan.documentIds.push(proposal.targetId);
      }
    }

    if (isEmpty()) {
      return {
        kind: "unsupported",
        reason: stampedNothing
          ? `Revert of a '${proposal.targetType}' create proposal is not supported: it created no new rows (it matched something that already existed), so there is nothing to undo.`
          : `Revert of a '${proposal.targetType}' create proposal is not supported: no materialized record of created rows.`,
      };
    }

    return plan;
  }

  return {
    kind: "unsupported",
    reason: `Revert of proposal type '${proposal.targetType}/${proposal.proposalType}' is not supported.`,
  };
}

/**
 * Would `revert` succeed for this proposal ONCE IT IS APPLIED? — the answer a
 * reviewer needs BEFORE deciding (swipe or tap? warn "can't be undone"?).
 *
 * `planProposalRevert` reads the record approval stamps (`data.materialized`),
 * which a pending proposal does not have yet, so it cannot be asked as-is about
 * a live row. It CAN be asked about everything that does not need that record:
 * an update/edit has no before-snapshot, a non-entity delete has no recoverable
 * target, an unmapped type is unsupported — all knowable from the type alone.
 * The one case the planner decides from the record is a composite graph, whose
 * created ids are minted at approval and stamped then; it is predicted
 * reversible because approval's stamp is what makes its revert possible.
 *
 * The planner stays the ONE place the kind→inverse rule lives: this asks it,
 * with the status it will have, rather than mirroring its branches. `status` is
 * not read by the planner; `"approved"` names the hypothetical.
 */
export function wouldBeRevertable(
  proposal: Omit<RevertPlannerInput, "status">
): boolean {
  const data =
    proposal.data && typeof proposal.data === "object"
      ? (proposal.data as StoredProposalData)
      : null;
  if (isCompositeProposalData(data)) return true;
  return (
    planProposalRevert({ ...proposal, status: "approved" }).kind !==
    "unsupported"
  );
}

/**
 * The list's per-row `revertable` — the ONE status matrix, called by
 * `proposals.list` so a test can drive exactly the code the wire uses.
 *
 *   - applied (approved / auto_approved): would `revert` succeed NOW — the
 *     planner over the stamped record;
 *   - live (pending / approval_failed): would it succeed ONCE APPLIED —
 *     {@link wouldBeRevertable}. This is the population a reviewer decides on;
 *     answering `false` for it made every pending card read as irreversible and
 *     left swipe-to-approve permanently off;
 *   - every other status (rejected, withdrawn, expired, reverted): `false` —
 *     nothing was applied, or it was already undone.
 */
export function revertableForRow(row: RevertPlannerInput): boolean {
  if (row.status === "approved" || row.status === "auto_approved") {
    return planProposalRevert(row).kind !== "unsupported";
  }
  if (row.status === "pending" || row.status === "approval_failed") {
    return wouldBeRevertable(row);
  }
  return false;
}

/**
 * The `delete-creations` plan for a materialized record — shared by
 * `planProposalRevert` (undo an approved proposal) and a connected plan's
 * COMPENSATION (undo what a failed plan had applied), so both undo from the
 * same record the same way.
 */
export function creationsPlanFromRecord(
  record: CompleteMaterializedRecord
): Extract<ProposalRevertPlan, { kind: "delete-creations" }> {
  return {
    kind: "delete-creations",
    entityIds: [...(record.entityIds ?? [])],
    relationIds: [...(record.relationIds ?? [])],
    documentIds: [...(record.documentIds ?? [])],
    facetIds: [...(record.facetIds ?? [])],
    skillIds: [...(record.skillIds ?? [])],
    automationIds: [...(record.automationIds ?? [])],
    ruleIds: [...(record.ruleIds ?? [])],
    propertyDiffs: [...(record.propertyDiffs ?? [])],
    sessionIds: [...(record.sessionIds ?? [])],
    projectIds: [...(record.projectIds ?? [])],
    linkIds: [...(record.linkIds ?? [])],
    projectSubjectIds: { ...(record.projectSubjectIds ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Single-item revert — ONE op of a composite proposal
// ---------------------------------------------------------------------------

export type ProposalOpRevertPlan =
  | {
      kind: "op";
      /** The narrowed inverse, same shape the whole-proposal revert runs. */
      plan: Extract<ProposalRevertPlan, { kind: "delete-creations" }>;
      /** The op itself plus the run's own links to it that go with it. */
      opKeys: string[];
    }
  | { kind: "already_reverted"; opKey: string; revertedAt: string }
  | { kind: "unknown_op"; opKey: string; available: string[] }
  /** Refused on purpose: undoing this item alone would also undo another live item's change. */
  | { kind: "refused"; reason: string }
  | { kind: "unsupported"; reason: string };

/** `<sourceRef>-><targetRef>:<type>` → its two refs (see `relationOpKey`). */
function relationRefs(
  key: string
): { sourceRef: string; targetRef: string } | null {
  const arrow = key.indexOf("->");
  const colon = key.lastIndexOf(":");
  if (arrow <= 0 || colon <= arrow + 2) return null;
  return {
    sourceRef: key.slice(0, arrow),
    targetRef: key.slice(arrow + 2, colon),
  };
}

/**
 * The inverse of ONE op, read from `data.materialized.byOp` — never re-derived
 * from the operations. An entity op takes its facets, what a merge overwrote on
 * a matched entity, and the run's OWN links to that entity (a link left
 * pointing at a retired entity is a dangling edge). Rows the op merely linked
 * (`linked` / `preExisting`) were never this run's and are not in the plan.
 */
export function planProposalOpRevert(
  proposal: RevertPlannerInput,
  opKey: string
): ProposalOpRevertPlan {
  const whole = planProposalRevert(proposal);
  if (whole.kind !== "delete-creations") {
    return whole.kind === "unsupported"
      ? whole
      : {
          kind: "unsupported",
          reason: `Only a proposal that created rows can be reverted one item at a time (this one is '${whole.kind}').`,
        };
  }
  const record = ((proposal.data as { materialized?: unknown } | null)
    ?.materialized ?? {}) as CompleteMaterializedRecord;
  const byOp = record.byOp ?? {};
  const entry = byOp[opKey];
  if (!entry) {
    return { kind: "unknown_op", opKey, available: Object.keys(byOp) };
  }
  if (entry.revertedAt) {
    return { kind: "already_reverted", opKey, revertedAt: entry.revertedAt };
  }

  const plan: Extract<ProposalRevertPlan, { kind: "delete-creations" }> = {
    kind: "delete-creations",
    entityIds: [],
    relationIds: [],
    documentIds: [],
    facetIds: [...(entry.facetIds ?? [])],
    skillIds: entry.skillId ? [entry.skillId] : [],
    automationIds: entry.automationId ? [entry.automationId] : [],
    ruleIds: entry.ruleId ? [entry.ruleId] : [],
    propertyDiffs: [],
  };
  const opKeys = [opKey];

  if (entry.op === "create_relation") {
    if (entry.relationId && !entry.preExisting)
      plan.relationIds.push(entry.relationId);
  } else if (entry.op === "create_entity" && entry.entityId) {
    // Two live items on ONE entity share its record: `stampMaterialized` keeps
    // one merged property diff per entity, so undoing this item alone would
    // restore (or retire) what the other item changed too. Refuse, and say so.
    const sharing = Object.entries(byOp)
      .filter(
        ([key, other]) =>
          key !== opKey &&
          !other.revertedAt &&
          other.op === "create_entity" &&
          other.entityId === entry.entityId
      )
      .map(([key]) => `'${key}'`);
    if (sharing.length > 0) {
      return {
        kind: "refused",
        reason: `Item '${opKey}' changed entity ${entry.entityId}, and so did ${sharing.join(", ")}. Their changes are recorded together, so undoing '${opKey}' alone would also undo theirs — revert the whole proposal instead.`,
      };
    }
    if (entry.linked) {
      plan.propertyDiffs.push(
        ...(record.propertyDiffs ?? []).filter(
          (d) => d.entityId === entry.entityId
        )
      );
    } else {
      plan.entityIds.push(entry.entityId);
    }
    for (const [key, other] of Object.entries(byOp)) {
      if (other.op !== "create_relation" || other.revertedAt) continue;
      if (!other.relationId || other.preExisting) continue;
      const refs = relationRefs(key);
      if (refs && (refs.sourceRef === opKey || refs.targetRef === opKey)) {
        plan.relationIds.push(other.relationId);
        opKeys.push(key);
      }
    }
  }

  const empty =
    plan.entityIds.length +
      plan.relationIds.length +
      plan.facetIds.length +
      plan.skillIds.length +
      plan.automationIds.length +
      plan.ruleIds.length +
      plan.propertyDiffs.length ===
    0;
  if (empty) {
    return {
      kind: "unsupported",
      reason: `Op '${opKey}' created nothing this proposal owns — it linked something that already existed and changed nothing on it.`,
    };
  }
  return { kind: "op", plan, opKeys };
}
