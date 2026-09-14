/**
 * Proposals service — shared data access behind the MCP proposal tools.
 *
 * The MCP handlers (`synap_list_proposals`, `synap_governance`,
 * `synap_revise_proposal`) delegate here so the adapter does ZERO bespoke DB
 * work. These preserve the adapter's exact, creator-scoped semantics — which
 * differ from the review-queue doors (`proposals.list`/`groups` and Hub
 * `GET /api/hub/proposals`, which floor on LENS ∪ OWNERSHIP via
 * `proposalUserFloor`, so they also admit a TEAMMATE's rows in a shared
 * workspace). This door is the pure-ownership lens and is NOT interchangeable
 * with them.
 */

import {
  db,
  proposals,
  focusSessions,
  ProposalStatus,
  eq,
  and,
  or,
  desc,
  drizzleSql,
} from "@synap/database";
import type { ProposalRevision } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { assertReviewedRevision } from "../../utils/reviewed-revision.js";
import {
  isCompositeProposalData,
  isNestedEnvelope,
} from "@synap-core/types/proposals";
import type { ProposalStatusFilter } from "../../routers/hub-protocol/rest/_codecs/proposal.js";
import { ownAgentUserFilter } from "../agent-identity-service.js";

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
  /**
   * Gate 2: session review pack. When set, floors by **session ownership**
   * (caller owns the focus_session) and lists all proposals for that session —
   * not only rows createdBy the agent key (agent vs human createdBy mismatch).
   */
  sessionId?: string;
  status?: string;
  limit?: number;
}): Promise<Array<typeof proposals.$inferSelect>> {
  const statusArg = params.status || "pending";
  // `satisfies` against the wire filter type: adding a status to the column
  // without naming it here is a compile error, not a silent fall-through to
  // PENDING — which is how both `auto_approved` and `expired` slipped past.
  const statusMap = {
    pending: ProposalStatus.PENDING,
    approved: ProposalStatus.APPROVED,
    rejected: ProposalStatus.REJECTED,
    auto_approved: ProposalStatus.AUTO_APPROVED,
    reverted: ProposalStatus.REVERTED,
    approval_failed: ProposalStatus.APPROVAL_FAILED,
    withdrawn: ProposalStatus.WITHDRAWN,
    expired: ProposalStatus.EXPIRED,
  } as const satisfies Record<
    Exclude<ProposalStatusFilter, "all">,
    ProposalStatus
  >;
  const status =
    (statusMap as Record<string, ProposalStatus>)[statusArg] ??
    ProposalStatus.PENDING;

  // Session pack path: verify ownership then list by sessionId only.
  if (params.sessionId) {
    const [owned] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, params.sessionId),
          eq(focusSessions.userId, params.createdBy)
        )
      )
      .limit(1);
    if (!owned) return [];

    const conditions = [eq(proposals.sessionId, params.sessionId)];
    if (statusArg !== "all") conditions.push(eq(proposals.status, status));
    return db
      .select()
      .from(proposals)
      .where(and(...conditions))
      .orderBy(desc(proposals.createdAt))
      .limit(params.limit ?? 20);
  }

  // AUTHOR FLOOR = me OR an agent I created.
  //
  // `createdBy` alone is the wrong column for agent lineage: it is overloaded
  // ("userId or agentUserId that authored this proposal" — schema/proposals.ts),
  // so a proposal filed by my own agent-user carries the AGENT's id there and
  // fell out of my own queue. Measured live: 4 of 6 pending rows returned.
  // Keying a lineage branch on `agentUserId` (FK-backed, always the agent)
  // catches the rows measured live. The THIRD branch covers the other half of
  // the overload: a write path that puts an agent id in `createdBy` while
  // leaving `agentUserId` NULL. No row on this pod has that shape today, and no
  // insert path produces it: every agent-authored write sets BOTH columns —
  // `permission-check.ts` (:1657/:1659 pending, :1226/:1227 auto-approve
  // receipt), `jobs/utils/automation-governance.ts` (:556/:557), and
  // `event-backed-proposal.ts` (:164/:179, whose `createdBy` can only fall back
  // to the agent id when `agentUserId` was passed). That invariant is
  // hand-maintained per call site with no tripwire, and has already been broken
  // once in the sibling direction (see the post-mortem comment at
  // `routers/capture.ts:2734`), so this branch is kept as the cheap structural
  // guard: both columns are indexed, so the extra semi-join is negligible.
  //
  // This deliberately does NOT reuse `utils/proposal-visibility.ts`'s rule: that
  // one's second branch is a WORKSPACE-MEMBERSHIP floor, which would admit a
  // TEAMMATE's agent-authored proposals in a shared workspace — the boundary
  // `utils/pending-capture-dedup.ts` defends. Only the lineage half transfers;
  // every branch here resolves through `ownAgentUserFilter`, floored on
  // `users.createdByUserId = me AND userType = 'agent'`.
  //
  // NOT a claim that the workspace floor is unreachable by an agent: it already
  // is. `synap_diagnose type:"proposal"` (services/diagnose/global.ts) counts
  // pending on the same MCP door under a workspace-bearing predicate.
  //
  // UPDATED (B1): the REVIEW-QUEUE doors — `proposals.list`/`groups` (tRPC)
  // and Hub `GET /api/hub/proposals` — no longer floor on the bare workspace
  // lens. Their default population is now LENS ∪ OWNERSHIP
  // (`proposalUserFloor`, routers/proposals/scope-conditions.ts), so a caller's
  // own row in an orphaned/unjoinable workspace is no longer invisible there.
  //
  // That does NOT make this queue interchangeable with them, and the contract
  // this comment protects is unchanged: THIS list is the pure-OWNERSHIP door
  // and must never acquire a workspace term. A membership branch here would
  // admit a TEAMMATE's rows — the union doors accept that deliberately (a
  // workspace admin is expected to review a teammate's proposal); this one is
  // the "what did *I* file" answer and must not. On a single-user pod the two
  // numbers coincide; add one teammate and they must not.
  const authorFloor = or(
    eq(proposals.createdBy, params.createdBy),
    ownAgentUserFilter(proposals.agentUserId, params.createdBy),
    ownAgentUserFilter(proposals.createdBy, params.createdBy)
  )!;
  const conditions = [authorFloor];
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

/**
 * Envelope keys that are SYSTEM-authored and therefore never patchable by a
 * revise, at either level a reader looks for them.
 *
 * `sourceFile` is the staged-blob reference (`{documentId, storageKey, …}`).
 * `stagedSourceBlobFrom` reads it off the envelope top level (composite
 * proposals) OR off `.data` (entity/update proposals), so both levels are
 * protected — checking only the top level would leave the nested door open.
 */
/**
 * Fields a revision may never SET, and which are restored if a wholesale `data`
 * replacement drops them.
 *
 * `sourceFile` — staged bytes; dropping it orphans them (no terminal door would
 * ever see a reference to discard).
 *
 * `sourceId` — an AUTHORITY INPUT, not descriptive data. `computeCanReviewApproval`
 * derives `isOwner` from it (`review-authority.ts:153`, `:202`), and under the
 * default `owner_and_admins` policy `isOwner` ALONE grants approval to a caller
 * with no workspace membership at all. Left patchable, an agent authorised by the
 * author rung could `patch: {fields:{sourceId:"<any user id>"}}` on its own pending
 * proposal and hand that user approval authority over it — converting "needs an
 * admin" into "this viewer can approve". The agent-class floor added alongside this
 * covers the READ (an agent naming ITSELF); it cannot cover the WRITE, which is why
 * the field is pinned here. Nothing a reviser legitimately expresses requires
 * changing it: it is stamped once, by the door that created the proposal.
 */
export const PROTECTED_ENVELOPE_FIELDS = [
  "sourceFile",
  "sourceId",
  // `connectionSync` — stamped ONLY by the connection-sync door when it files a
  // connection's import.graph. It is an AUTHORITY INPUT twice over: approving a
  // proposal that carries it can mint the connection's `auto` governance rule
  // (`applyConnectionSyncApproval`), and every write materialized from it is
  // tagged `origin: "sync"`, which silently skips every event automation. A
  // revise that could set it would let any reviser suppress automations on an
  // unrelated approval, or plant `keepSyncing` on a pending import.
  "connectionSync",
  // `sessionSource` — stamped ONLY by `insertPendingProposal` when the row's
  // session was DERIVED (a guess, not named). It is an AUTHORITY INPUT: both
  // approve doors read it (`storedSessionSource`) to keep the guessed session's
  // project off the approved entities, because `belongs_to_project` widens
  // access. A reviser that could clear it would re-arm that placement on its own
  // pending proposal; one that could plant it would strip a real project.
  "sessionSource",
] as const;

/**
 * The protected field a patch would SET or ALTER at either level, or null.
 *
 * Returns the offending KEY rather than a boolean so the error can name the
 * field the caller actually touched. The message used to hardcode `sourceFile`,
 * which was correct while that was the only entry and became a lie the moment a
 * second one was added — telling a caller to stop sending a field they never
 * sent. Prose in this codebase is executable; the message is derived, not typed.
 */
function patchTouchesProtectedField(
  fields: Record<string, unknown>
): (typeof PROTECTED_ENVELOPE_FIELDS)[number] | null {
  const nested =
    fields.data &&
    typeof fields.data === "object" &&
    !Array.isArray(fields.data)
      ? (fields.data as Record<string, unknown>)
      : undefined;
  return (
    PROTECTED_ENVELOPE_FIELDS.find(
      (key) =>
        Object.hasOwn(fields, key) ||
        (nested ? Object.hasOwn(nested, key) : false)
    ) ?? null
  );
}

/** Why each protected field is refused — shown to the caller that touched it. */
const PROTECTED_FIELD_REASON: Record<
  (typeof PROTECTED_ENVELOPE_FIELDS)[number],
  string
> = {
  sourceFile: "it is system-authored file provenance, not reviewable content",
  sourceId:
    "it is the authority input reviewer eligibility is derived from, not reviewable content",
  connectionSync:
    "it is stamped by the connection-sync door and decides automation fan-out and sync governance, not reviewable content",
  sessionSource:
    "it records that the proposal's session was guessed, and decides whether approval places the write into that session's project, not reviewable content",
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
  /**
   * The AGENT that filed this revision on `actorId`'s behalf, when there is
   * one — recorded as `actingAgentUserId` on the entry. Attribution only.
   */
  actingAgentUserId?: string | null;
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

  // ── System-authored provenance is not reviewer-editable ─────────────────
  // `data.sourceFile` is written ONLY by `stageSourceBlob`'s callers and names
  // a `documents` row + storage key that the approval path LINKS onto an entity
  // and the rejection path DELETES. A revise that could set it turned the
  // reviewer's own edit door into a cross-tenant primitive: point your own
  // proposal at someone else's documentId, approve, and `entities.document_id`
  // — the column the presigned-URL door trusts — hands you their bytes.
  // Enforced HERE, in the shared core, so all three revise doors (tRPC
  // `revise`, MCP `synap_revise_proposal`, Hub `updateProposal`) inherit it.
  const protectedField = patch
    ? patchTouchesProtectedField(patch.fields)
    : null;
  if (protectedField) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `A revision cannot set or alter \`${protectedField}\` — ` +
        `${PROTECTED_FIELD_REASON[protectedField]}.`,
    });
  }
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

  // …and re-pin the protected provenance the same way. The patch cannot SET it
  // (rejected above), but an envelope patch that REPLACES `data` wholesale —
  // which is exactly what the Studio's "Save & Approve" sends — would drop a
  // nested `sourceFile` and orphan the staged bytes: no terminal door would
  // ever see a reference to discard. Restoring is the whole fix; there is
  // nothing a reviewer legitimately expresses by removing it.
  for (const key of PROTECTED_ENVELOPE_FIELDS) {
    if (envelope[key] !== undefined) merged[key] = envelope[key];
    const priorInner = envelope.data;
    if (
      priorInner &&
      typeof priorInner === "object" &&
      !Array.isArray(priorInner) &&
      (priorInner as Record<string, unknown>)[key] !== undefined &&
      merged.data &&
      typeof merged.data === "object" &&
      !Array.isArray(merged.data)
    ) {
      (merged.data as Record<string, unknown>)[key] = (
        priorInner as Record<string, unknown>
      )[key];
    }
  }

  // `by` is the HUMAN the call acts for (every door passes the key owner), so an
  // agent's revision is indistinguishable from the human's own edit unless the
  // acting agent is recorded beside it — the agent scorecard reads this to count
  // only human corrections (B21). JSONB entry; absent on human revisions.
  const revision: ProposalRevision & { actingAgentUserId?: string } = {
    at: new Date().toISOString(),
    by: actorId ?? null,
    ...(params.actingAgentUserId
      ? { actingAgentUserId: params.actingAgentUserId }
      : {}),
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
   * AUTHOR RUNG (A). The AGENT principal filing this revision, when the caller
   * is an agent key — i.e. RFC 8693's `act`: the agent acting FOR the human in
   * `actorId`, with its own identity, never indistinguishable from them.
   *
   * Used ONLY to authorize an agent amending ITS OWN pending proposal
   * (`proposals.agentUserId === actingAgentUserId`). It is deliberately NOT
   * passed to `computeCanReviewApproval` — feeding an agent id into the
   * reviewer ladder is a self-approval hole, because `data.sourceId` holds the
   * AGENT on the dev-approval/stage-gate doors, which would make `isOwner` true
   * and hand the agent full reviewer authority over its own proposal under the
   * default `owner_and_admins` policy. Author authority and reviewer authority
   * are separate rungs and must stay separate.
   */
  actingAgentUserId?: string | null;
  /**
   * ATTRIBUTION ONLY: the agent to record on the revision entry when the door
   * must NOT grant the author rung (the Hub door, whose `actorId` is the key's
   * human owner). Never read by authorization. Defaults to `actingAgentUserId`.
   */
  attributionAgentUserId?: string | null;
  /**
   * The `revisionHistory.length` the reviser saw (e.g. an anchored comment's
   * `contentVersion`). Asserted UNDER the row lock: a revise against content
   * that has since been revised is refused with CONFLICT instead of silently
   * applying a comment to a version its author never saw. Undefined = no-op.
   */
  expectedRevision?: number;
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
  // ── Composite / plan revisions are RE-VALIDATED ─────────────────────────
  // A revision that replaces `operations` runs the SAME preflight a submit
  // runs (properties, reserved kinds, relation types, plan refs / cycles /
  // limits / ownership / evidence). Computed BEFORE the row lock — the
  // preflight reads through the shared pool, and holding the lock across it
  // would serialize every reader behind one revise — and REFUSED inside the
  // lock only after authority passes, so an unauthorized caller still reads
  // NOT_FOUND and learns nothing about the proposal's shape. `operations` is
  // replaced wholesale by a revision, so the verdict does not depend on the
  // stored base a concurrent revise might change.
  const revisionCheck = await validateRevisedOperations(params);
  const patch =
    revisionCheck && params.patch
      ? {
          ...params.patch,
          fields: {
            ...params.patch.fields,
            operations: revisionCheck.operations,
          },
        }
      : params.patch;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        data: proposals.data,
        status: proposals.status,
        // Authority inputs — see the review-authority gate below.
        workspaceId: proposals.workspaceId,
        agentUserId: proposals.agentUserId,
        revisionHistory: proposals.revisionHistory,
      })
      .from(proposals)
      .where(eq(proposals.id, params.proposalId))
      .limit(1)
      .for("update");

    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    }

    // ── Review authority ────────────────────────────────────────────────────
    // A revise rewrites `summary` / `reasoning` — the exact text a human reads
    // when deciding to approve — so it requires the SAME authority as approve.
    // The gate lives HERE, in the one shared revise core, rather than at each
    // door: `proposals.revise` (tRPC) had it, while the MCP door
    // (`synap_revise_proposal` → `reviseProposal`) and the Hub door
    // (`hub-protocol/proposals.ts` `updateProposal`) both reached this core with
    // a RAW caller-supplied proposal id and no predicate at all — an agent could
    // rewrite the evidence under any pending proposal on the pod by id. One gate
    // in the core cannot drift out of the doors the way three copies can.
    //
    // Fail CLOSED: an absent `actorId` is not authorization. Every caller today
    // passes the authenticated user id.
    // NOT_FOUND (not FORBIDDEN) so an unauthorized caller cannot use this door
    // as an existence/status oracle for another user's proposals.
    // AUTHOR RUNG (A) — checked FIRST, and entirely separately from the
    // reviewer ladder. An agent may amend the proposal IT ITSELF authored: it is
    // still asking, not deciding, so amending its own pending request needs no
    // reviewer authority. This is the same author/owner-vs-reviewer split
    // `proposals.withdraw` already draws (routers/proposals.ts:1670 — a
    // proposer-only gate that explicitly refuses the reviewer ladder).
    //
    // Matched on the AGENT principal (`proposals.agentUserId`, already selected
    // in this transaction above), never on `data.sourceId` — which holds a
    // different principal per door and is not a reliable agent id.
    //
    // ⛔ The agent id is NOT forwarded into `computeCanReviewApproval` below.
    // Author authority lets an agent change WHAT IT IS ASKING FOR; it never
    // lets the agent decide the request. A human still approves.
    const isAuthor =
      !!params.actingAgentUserId &&
      existing.agentUserId === params.actingAgentUserId;

    const { computeCanReviewApproval } =
      await import("../../routers/proposals/review-authority.js");
    const { allowed: canReview } =
      !isAuthor && params.actorId
        ? await computeCanReviewApproval({
            // Reviewer-revise bar, unchanged. The AUTHOR path never reaches
            // here (`!isAuthor` guards it), so this cannot gate an agent
            // amending its own proposal.
            purpose: "reject" as const,
            proposal: {
              workspaceId: existing.workspaceId,
              data: existing.data,
              agentUserId: existing.agentUserId,
            },
            userId: params.actorId,
          })
        : { allowed: false };
    if (!isAuthor && !canReview) {
      // NOT_FOUND (not FORBIDDEN) so an unauthorized caller cannot use this door
      // as an existence/status oracle for another user's proposals — the
      // pre-existing semantics of this gate, preserved deliberately.
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    }

    if (existing.status !== ProposalStatus.PENDING) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This proposal is no longer pending — it was reviewed elsewhere. Reload to see its current state.",
      });
    }

    // Stale-content guard, inside the lock (after authority, so an unauthorized
    // caller still reads NOT_FOUND and learns nothing from the version).
    assertReviewedRevision(params.expectedRevision, existing.revisionHistory);

    if (revisionCheck && revisionCheck.problems.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `Revision refused — the revised operations cannot apply, so nothing was changed (the proposal stays pending as it was):\n` +
          revisionCheck.problems.map((p) => `• ${p}`).join("\n") +
          `\nSend the FULL corrected operations again.`,
      });
    }

    const { merged, revision } = computeRevisedEnvelope({
      envelope: (existing.data ?? {}) as Record<string, unknown>,
      patch,
      summary: params.summary,
      reasoning: params.reasoning,
      actorId: params.actorId,
      actingAgentUserId:
        params.attributionAgentUserId ?? params.actingAgentUserId ?? null,
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
 * The re-validation half of a revision that replaces `operations`. Null when
 * the patch does not touch `operations` (nothing to validate).
 *
 * The owner the plan's floors are judged for is the proposal's SUBJECT user —
 * the principal the proposal was filed for, whose sessions and entities the
 * steps name — never the reviser, so an admin revising someone's plan cannot
 * point it at the admin's own sessions.
 */
async function validateRevisedOperations(
  params: MergeProposalRevisionParams
): Promise<{ problems: string[]; operations: unknown } | null> {
  const revised = params.patch?.fields?.operations;
  if (revised === undefined) return null;
  const [row] = await db
    .select({
      workspaceId: proposals.workspaceId,
      subjectUserId: proposals.subjectUserId,
      createdBy: proposals.createdBy,
      data: proposals.data,
    })
    .from(proposals)
    .where(eq(proposals.id, params.proposalId))
    .limit(1);
  // Absent row: the locked read below answers NOT_FOUND.
  if (!row) return null;
  // Only a composite proposal carries `operations` as its payload.
  if (!isCompositeProposalData(row.data as never)) return null;
  const candidate = { operations: revised };
  if (!isCompositeProposalData(candidate as never)) {
    return {
      problems: [
        "`operations` must be a non-empty array of recognized composite operations (create_entity, create_relation, create_skill, create_automation, create_rule, create_project, create_session, create_document, create_link)",
      ],
      operations: revised,
    };
  }
  const { validateCompositeOperations } =
    await import("../capture-agent/submit-capture-graph.js");
  return validateCompositeOperations(db, {
    operations: (candidate as { operations: never }).operations,
    userId: row.subjectUserId ?? row.createdBy ?? params.actorId ?? "",
    workspaceId:
      params.workspaceId !== undefined ? params.workspaceId : row.workspaceId,
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
  /**
   * Amend WHAT WILL BE CREATED, not just the narrative a human reads. Without
   * it an agent could rewrite its summary while the payload it described stayed
   * unchanged — narrative and payload silently diverging is worse than no
   * amendment at all, because the human reads the narrative.
   */
  patch?: ProposalRevisionPatch;
  /** The actor filing the revision — recorded as `by` on the history entry. */
  actorId?: string | null;
  /** The acting AGENT principal, enabling the author rung (see the core). */
  actingAgentUserId?: string | null;
}): Promise<void> {
  await mergeProposalRevision({
    proposalId: params.proposalId,
    summary: params.summary,
    reasoning: params.reasoning,
    patch: params.patch,
    actorId: params.actorId,
    actingAgentUserId: params.actingAgentUserId,
  });
}
