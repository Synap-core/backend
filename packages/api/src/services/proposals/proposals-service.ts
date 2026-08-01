/**
 * Proposals service — shared data access behind the MCP proposal tools.
 *
 * The MCP handlers (`synap_list_proposals`, `synap_governance`,
 * `synap_revise_proposal`) delegate here so the adapter does ZERO bespoke DB
 * work. These preserve the adapter's exact, creator-scoped semantics — which
 * differ from the Hub `proposals` tRPC router (that one scopes by workspace
 * visibility, not `createdBy`, so it is NOT interchangeable here).
 */

import {
  db,
  proposals,
  ProposalStatus,
  eq,
  and,
  desc,
  drizzleSql,
} from "@synap/database";
import type { ProposalRevision } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { isNestedEnvelope } from "@synap-core/types/proposals";

/**
 * List proposals CREATED BY a user (optionally narrowed to a workspace/status),
 * newest first. `status` accepts the MCP arg strings — anything other than a
 * known state (or "all") maps to PENDING, and "all" skips the filter.
 *
 * Every value the `proposals.status` column can hold is selectable. Notably
 * `auto_approved`: an auto-approved agent write executes immediately and files
 * a proposal row purely as an audit receipt ("audited here for traceability" —
 * schema/proposals.ts). While this map held only three states, those receipts
 * were unlistable — and worse, asking for `auto_approved` silently fell through
 * to PENDING and returned a confidently wrong list.
 */
export async function listCreatedProposals(params: {
  createdBy: string;
  workspaceId?: string;
  status?: string;
  limit?: number;
}): Promise<Array<typeof proposals.$inferSelect>> {
  const statusArg = params.status || "pending";
  const statusMap: Record<string, ProposalStatus> = {
    pending: ProposalStatus.PENDING,
    approved: ProposalStatus.APPROVED,
    rejected: ProposalStatus.REJECTED,
    auto_approved: ProposalStatus.AUTO_APPROVED,
    reverted: ProposalStatus.REVERTED,
    approval_failed: ProposalStatus.APPROVAL_FAILED,
    withdrawn: ProposalStatus.WITHDRAWN,
  };
  const status = statusMap[statusArg] ?? ProposalStatus.PENDING;

  const conditions = [eq(proposals.createdBy, params.createdBy)];
  if (params.workspaceId)
    conditions.push(eq(proposals.workspaceId, params.workspaceId));
  if (statusArg !== "all") conditions.push(eq(proposals.status, status));

  return db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt))
    .limit(params.limit ?? 20);
}

/** Count PENDING proposals in a workspace (all authors). */
export async function countPendingProposals(
  workspaceId: string
): Promise<number> {
  const rows = await db
    .select({ count: drizzleSql<number>`cast(count(*) as integer)` })
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Shared revise core — the ONE door every "merge a patch into a pending
// proposal" caller routes through (tRPC `revise`, hub `updateProposal`, MCP
// `reviseProposal`). Folds in the best of the three doors that had drifted:
//   • row-lock (`SELECT … FOR UPDATE`) so no lost update  (was Door C's strength)
//   • assert PENDING under the lock → CONFLICT, never silent success (Door A intent)
//   • the ONE nesting contract (`isNestedEnvelope`) so an inner-fields patch lands
//     in the SAME slot the approve executors read, regardless of caller
//   • append a `revisionHistory` entry on EVERY revise (was Door C only) so
//     "Save & Approve" is finally recorded for the analyzer loop
// ---------------------------------------------------------------------------

/**
 * A field-edit patch expressed in the caller's own language:
 *   - `"inner"`   — inner entity-level fields (the IS `update_proposal` tool and
 *     any programmatic reviser send these FLAT). For a nested-reader envelope
 *     they merge into `envelope.data` (the slot the executor reads); for a flat
 *     envelope (document / composite `{operations}` / capability.* / workspace/*)
 *     they merge at the top level.
 *   - `"envelope"` — a top-level envelope patch. The Studio reviewer's
 *     "Save & Approve" pre-wraps its edited inner as `{ data: inner }`, so the
 *     tRPC `revise` door hands that through verbatim as an envelope patch —
 *     byte-identical to the historic top-level merge.
 */
export type ProposalRevisionPatch = {
  kind: "inner" | "envelope";
  fields: Record<string, unknown>;
};

export interface ComputeRevisedEnvelopeParams {
  /** The stored `proposals.data` envelope (never mutated). */
  envelope: Record<string, unknown>;
  /** Optional field edits (see {@link ProposalRevisionPatch}). */
  patch?: ProposalRevisionPatch;
  /** Human-readable summary — stored as `_summary` at the envelope top level. */
  summary?: string;
  /** Reasoning — stored as `reasoning` at the envelope top level. */
  reasoning?: string;
  /** The actor filing the revision — recorded as `by` on the history entry. */
  actorId?: string | null;
}

/**
 * PURE (no DB): compute the merged envelope + the `revisionHistory` entry for a
 * revise. The nesting decision is the shared `isNestedEnvelope` SSOT — the exact
 * predicate `buildRequestFromProposal` and the approve executors branch on — so
 * the SAME logical edit produces the SAME stored shape regardless of door.
 * Identity fields (`targetType`/`changeType`/`requestId`) are ALWAYS re-pinned
 * from the original envelope so a patch can never clobber what approve keys on.
 */
export function computeRevisedEnvelope(params: ComputeRevisedEnvelopeParams): {
  merged: Record<string, unknown>;
  revision: ProposalRevision;
} {
  const { envelope, patch, summary, reasoning, actorId } = params;
  const before: Record<string, unknown> = {};
  const historyPatch: Record<string, unknown> = {};

  let merged: Record<string, unknown> = { ...envelope };

  if (patch) {
    if (patch.kind === "inner" && isNestedEnvelope(envelope)) {
      // Inner-fields patch onto a nested-reader envelope → merge into `.data`.
      const priorInner = (envelope.data ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(patch.fields)) {
        before[key] = priorInner[key];
        historyPatch[key] = patch.fields[key];
      }
      merged.data = { ...priorInner, ...patch.fields };
    } else {
      // Envelope patch, OR an inner patch onto a flat envelope → merge at top.
      for (const key of Object.keys(patch.fields)) {
        before[key] = envelope[key];
        historyPatch[key] = patch.fields[key];
      }
      merged = { ...merged, ...patch.fields };
    }
  }

  if (summary !== undefined) {
    before._summary = envelope._summary;
    historyPatch._summary = summary;
    merged._summary = summary;
  }
  if (reasoning !== undefined) {
    before.reasoning = envelope.reasoning;
    historyPatch.reasoning = reasoning;
    merged.reasoning = reasoning;
  }

  // Re-pin identity from the ORIGINAL envelope (mirrors the historic hub + tRPC
  // merges — undefined values serialize away, so this is byte-identical for the
  // flat envelopes that carry these at the row level instead).
  merged.targetType = envelope.targetType;
  merged.changeType = envelope.changeType;
  merged.requestId = envelope.requestId;

  const revision: ProposalRevision = {
    at: new Date().toISOString(),
    by: actorId ?? null,
    before,
    patch: historyPatch,
  };
  return { merged, revision };
}

export interface MergeProposalRevisionParams {
  proposalId: string;
  patch?: ProposalRevisionPatch;
  summary?: string;
  reasoning?: string;
  /** The actor filing the revision — recorded as `by` on the history entry. */
  actorId?: string | null;
  /**
   * Re-target this pending proposal's destination workspace — the TOP-LEVEL
   * `proposals.workspace_id` column, not `data.workspaceId`. Every visibility/
   * approval gate and the approve materializer key off this column, so a
   * `data`-only patch can never actually move a proposal between workspaces.
   * `undefined` = leave unchanged; `null` = make it pod-wide.
   */
  workspaceId?: string | null;
  /** Re-target this pending proposal's destination project (top-level
   * `proposals.project_id` column). `undefined` = leave unchanged. */
  projectId?: string | null;
}

/**
 * Merge a patch into a still-pending proposal — the shared revise door.
 *
 * Row-locks the proposal (`FOR UPDATE`), asserts it is still PENDING (a decided
 * or concurrently-flipped proposal throws CONFLICT — never a silent no-op that
 * would drop the reviser's edits while approve materializes the original), then
 * writes the merged envelope + appended `revisionHistory` atomically.
 */
export async function mergeProposalRevision(
  params: MergeProposalRevisionParams
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ data: proposals.data, status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, params.proposalId))
      .limit(1)
      .for("update");

    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    }
    if (existing.status !== ProposalStatus.PENDING) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This proposal is no longer pending — it was reviewed elsewhere. Reload to see its current state.",
      });
    }

    const { merged, revision } = computeRevisedEnvelope({
      envelope: (existing.data ?? {}) as Record<string, unknown>,
      patch: params.patch,
      summary: params.summary,
      reasoning: params.reasoning,
      actorId: params.actorId,
    });

    // postgres.js 3.4.8 sql.json() is broken on the pod image — always
    // JSON.stringify + ::jsonb. In Drizzle .set() use drizzleSql, not raw sql.
    // The lock already holds PENDING; the WHERE re-guard is belt-and-suspenders.
    await tx
      .update(proposals)
      .set({
        data: merged as typeof proposals.$inferInsert.data,
        revisionHistory: drizzleSql`COALESCE(${proposals.revisionHistory}, '[]'::jsonb) || ${JSON.stringify([revision])}::jsonb`,
        updatedAt: new Date(),
        ...(params.workspaceId !== undefined
          ? { workspaceId: params.workspaceId }
          : {}),
        ...(params.projectId !== undefined
          ? { projectId: params.projectId }
          : {}),
      })
      .where(
        and(
          eq(proposals.id, params.proposalId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      );
  });
}

/**
 * Revise the human-readable `summary` / `reasoning` of a still-pending
 * proposal — the MCP `synap_revise_proposal` door. Thin wrapper over the shared
 * `mergeProposalRevision` core (which row-locks, asserts PENDING → CONFLICT, and
 * appends the `revisionHistory` entry). No-op fields are ignored by the caller
 * (which requires at least one).
 */
export async function reviseProposal(params: {
  proposalId: string;
  summary?: string;
  reasoning?: string;
  /** The actor filing the revision — recorded as `by` on the history entry. */
  actorId?: string | null;
}): Promise<void> {
  await mergeProposalRevision({
    proposalId: params.proposalId,
    summary: params.summary,
    reasoning: params.reasoning,
    actorId: params.actorId,
  });
}
