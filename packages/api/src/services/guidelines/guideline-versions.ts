/**
 * Guideline versions from CORRECTIONS — the two write paths of the feedback
 * loop (intake plan §3.4, W5), both thin wrappers over the ONE guideline store
 * (`createGuideline` / `supersedeGuideline` / `findCurrentGuideline`,
 * `@synap/database`).
 *
 * Founder decision: corrections become VERSIONED guideline text, never opaque
 * memory.
 *   - A user's OWN correction ("make this a rule") → a guideline version
 *     DIRECTLY: `recordCorrectionAsGuideline`, through the room's door
 *     `guidelines.recordCorrection`. The same door called by an AGENT key
 *     files `proposeCorrectionAsGuideline` instead — never a direct write.
 *   - An INFERRED pattern → ONE proposal the user reviews, filed by the
 *     structure-guideline scanner (`packages/jobs/src/workers/
 *     structure-guideline-scanner.ts`); approving it runs
 *     `approveStructureGuidelineProposal` from `applyProposalApproval`.
 *
 * Both land on the SAME rung-and-lens identity: if a current guideline exists
 * for (scopeKind, scopeRef, workspace | owner), the new text SUPERSEDES it
 * (version + 1, `supersedesId`) — never a parallel second row. Lineage rides in
 * `source`: `proposal:<id>` for an approved inferred guideline,
 * `correction:<proposalId>` (or `correction`) for a stated one.
 *
 * AUTHORITY (founder D1): whoever the guideline applies to decides — see
 * `assertCanApproveStructureGuideline`. CONFLICT ON APPROVE (founder D2): never
 * a dead end — see `approveStructureGuidelineProposal`.
 *
 * `recordCorrectionAsGuideline` leaves ACCESS to its caller, exactly like
 * `createGuideline`: a workspace-scoped guideline biases every member, so the
 * caller must hold editor authority there (the tRPC `guidelines` router's floor).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  drizzleSql,
  proposals,
  createGuideline,
  supersedeGuideline,
  findCurrentGuideline,
  insertPendingProposal,
  GuidelineSupersedeConflictError,
  GUIDELINE_TEXT_MAX,
  STRUCTURE_GUIDELINE_PROPOSAL_TYPE,
  type CurrentGuideline,
  type StructureGuidelineProposalData,
  type StructureGuidelineScopeKind,
} from "@synap/database";
import { profiles, ProposalStatus } from "@synap/database/schema";
import type { ConfigSetting } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { isGuidelineSourceKind } from "./source-kind.js";
import { getWorkspaceRole, isPodAdmin } from "../../utils/workspace-role.js";
import { mergeProposalRevision } from "../proposals/proposals-service.js";

export interface CorrectionGuidelineScope {
  scopeKind: StructureGuidelineScopeKind;
  /** Required for sourceKind/entityKind; must be absent for default. */
  scopeRef?: string | null;
  /** NULL = pod-wide (owner-floored on read). */
  workspaceId?: string | null;
}

/** Injected store access — defaults to the real store; tests pass fakes. */
export interface GuidelineVersionDeps {
  findCurrent(
    scope: CorrectionGuidelineScope,
    userId: string
  ): Promise<CurrentGuideline | null>;
  kindExists(profileSlug: string): Promise<boolean>;
  create(input: {
    scope: CorrectionGuidelineScope;
    text: string;
    source: string;
    createdBy: string;
  }): Promise<ConfigSetting>;
  supersede(input: {
    id: string;
    text: string;
    source: string;
    createdBy: string;
  }): Promise<ConfigSetting>;
}

export const guidelineVersionDbDeps: GuidelineVersionDeps = {
  findCurrent: (scope, userId) =>
    findCurrentGuideline({
      db,
      userId,
      scopeKind: scope.scopeKind,
      scopeRef: scope.scopeRef ?? null,
      workspaceId: scope.workspaceId ?? null,
    }),
  async kindExists(profileSlug) {
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.slug, profileSlug),
      columns: { id: true },
    });
    return !!profile;
  },
  create: ({ scope, text, source, createdBy }) =>
    createGuideline({
      db,
      text,
      scopeKind: scope.scopeKind,
      scopeRef: scope.scopeRef ?? null,
      workspaceId: scope.workspaceId ?? null,
      source,
      createdBy,
    }),
  async supersede({ id, text, source, createdBy }) {
    const { guideline } = await supersedeGuideline({
      db,
      id,
      text,
      source,
      createdBy,
    });
    return guideline;
  },
};

/** The rung's ref vocabulary — the same gates the guidelines write door applies. */
async function assertScope(
  scope: CorrectionGuidelineScope,
  deps: Pick<GuidelineVersionDeps, "kindExists">
): Promise<void> {
  const ref = scope.scopeRef ?? null;
  const bad = (message: string) =>
    new TRPCError({ code: "BAD_REQUEST", message });
  if (scope.scopeKind === "default") {
    if (ref) throw bad("A default-scoped guideline takes no scopeRef.");
    return;
  }
  if (!ref)
    throw bad(`scopeRef is required for scopeKind '${scope.scopeKind}'.`);
  if (scope.scopeKind === "sourceKind" && !isGuidelineSourceKind(ref)) {
    throw bad(`"${ref}" is not a guideline source kind.`);
  }
  if (scope.scopeKind === "entityKind" && !(await deps.kindExists(ref))) {
    throw bad(`No kind "${ref}" exists in this pod.`);
  }
}

function assertTextFits(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A guideline needs text.",
    });
  }
  if (trimmed.length > GUIDELINE_TEXT_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A guideline is at most ${GUIDELINE_TEXT_MAX} characters — shorten it before approving.`,
    });
  }
  return trimmed;
}

/** The next version's text: the current guideline plus the correction. */
function appendCorrection(
  current: CurrentGuideline | null,
  correction: string
): string {
  return assertTextFits(
    current?.text.trim()
      ? `${current.text.trim()}\n\n${correction}`
      : correction
  );
}

// ── userStated: a human's own correction ────────────────────────────────────

/**
 * The userStated path: a human's own correction becomes a guideline version
 * NOW. The correction text is ADDED to the current guideline at that scope
 * (a new version whose diff is exactly the correction), or starts version 1.
 * A lost supersede race answers CONFLICT — the caller is interactive and can
 * simply retry against the new current version.
 */
export async function recordCorrectionAsGuideline(
  input: {
    userId: string;
    scope: CorrectionGuidelineScope;
    text: string;
    /** The proposal the correction was made on — lineage in `source`. */
    sourceProposalId?: string | null;
  },
  deps: GuidelineVersionDeps = guidelineVersionDbDeps
): Promise<{ guideline: ConfigSetting; supersededId: string | null }> {
  await assertScope(input.scope, deps);
  const correction = assertTextFits(input.text);
  const current = await deps.findCurrent(input.scope, input.userId);
  const text = appendCorrection(current, correction);
  const source = input.sourceProposalId
    ? `correction:${input.sourceProposalId}`
    : "correction";
  try {
    const guideline = current
      ? await deps.supersede({
          id: current.id,
          text,
          source,
          createdBy: input.userId,
        })
      : await deps.create({
          scope: input.scope,
          text,
          source,
          createdBy: input.userId,
        });
    return { guideline, supersededId: current?.id ?? null };
  } catch (err) {
    if (err instanceof GuidelineSupersedeConflictError) {
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    }
    throw err;
  }
}

// ── Agent-stated: the same correction, PROPOSED ─────────────────────────────

const logger = createLogger({ module: "guideline-versions" });

/**
 * The dedup identity of a correction proposal. Its OWN namespace — never the
 * scanner's `structureClusterKey` — so a pending stated correction and the
 * scanner's inferred cluster can never silence each other.
 *
 * Stored in `proposals.data` (jsonb), so it must be JSON-text-safe: Postgres
 * refuses `\u0000` in jsonb (22P05). JSON-encoding the parts keeps them
 * unambiguous without a NUL separator.
 */
export function correctionClusterKey(input: {
  userId: string;
  scope: CorrectionGuidelineScope;
}): string {
  const { scope } = input;
  return `correction:${JSON.stringify([
    input.userId,
    scope.scopeKind,
    scope.scopeRef ?? null,
    scope.workspaceId ?? null,
  ])}`;
}

export interface CorrectionProposalDeps extends Pick<
  GuidelineVersionDeps,
  "findCurrent" | "kindExists"
> {
  /** The id of a still-PENDING proposal already filed under `clusterKey`. */
  findPendingForCluster(clusterKey: string): Promise<string | null>;
  fileProposal(input: {
    data: StructureGuidelineProposalLike;
    workspaceId: string | null;
    userId: string;
    agentUserId: string;
  }): Promise<string>;
}

/**
 * The stored payload. `evidence.windowDays` is ABSENT: one stated correction
 * has no scan window, and the presenter reads a missing count as "not shown",
 * never as a fabricated number.
 */
type StructureGuidelineProposalLike = Omit<
  StructureGuidelineProposalData,
  "evidence"
> & {
  evidence: Omit<StructureGuidelineProposalData["evidence"], "windowDays">;
};

export const correctionProposalDbDeps: CorrectionProposalDeps = {
  findCurrent: guidelineVersionDbDeps.findCurrent,
  kindExists: guidelineVersionDbDeps.kindExists,
  // Same predicate as the scanner's `latestProposalForCluster`
  // (`data->>'clusterKey'`), narrowed to PENDING: the jobs package owns that
  // one and api cannot import jobs, and a decided proposal must not block a
  // new ask.
  async findPendingForCluster(clusterKey) {
    const [row] = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.proposalType, STRUCTURE_GUIDELINE_PROPOSAL_TYPE),
          eq(proposals.status, ProposalStatus.PENDING),
          drizzleSql`${proposals.data}->>'clusterKey' = ${clusterKey}`
        )
      )
      .limit(1);
    return row?.id ?? null;
  },
  async fileProposal({ data, workspaceId, userId, agentUserId }) {
    // `db` passed explicitly: the one pending-proposal door, on this module's
    // connection.
    const { proposal } = await insertPendingProposal(
      {
        workspaceId,
        targetType: "governance",
        targetId: userId,
        proposalType: STRUCTURE_GUIDELINE_PROPOSAL_TYPE,
        data: data as unknown as Record<string, unknown>,
        createdBy: userId,
        proposedByUserId: null,
        // OWNER FLOOR (0248): the human the guideline applies to decides (D1).
        subjectUserId: userId,
        agentUserId,
      },
      db
    );
    void emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId,
      data: {
        proposalStatus: "created",
        targetType: "governance",
        changeType: STRUCTURE_GUIDELINE_PROPOSAL_TYPE,
      },
    }).catch((err) => {
      logger.warn(
        { err, proposalId: proposal.id },
        "correction guideline proposal: emitSideEffects failed (non-fatal)"
      );
    });
    return proposal.id;
  },
};

/**
 * An AGENT asked to make a correction a rule. An agent never records a
 * guideline: it files the SAME `governance.structure_guideline` proposal the
 * scanner files, so approval runs `approveStructureGuidelineProposal` with its
 * audience authority (D1) and rebase-on-conflict (D2) unchanged. The drafted
 * text is the current version + the correction, exactly what the human path
 * would have written.
 */
export async function proposeCorrectionAsGuideline(
  input: {
    /** The HUMAN the agent acts for — the guideline's owner and subject. */
    userId: string;
    agentUserId: string;
    scope: CorrectionGuidelineScope;
    text: string;
    sourceProposalId: string;
  },
  deps: CorrectionProposalDeps = correctionProposalDbDeps
): Promise<{ proposalId: string; alreadyProposed: boolean }> {
  await assertScope(input.scope, deps);
  const addition = assertTextFits(input.text);
  // The dedup identity is CHECKED, not just stored: one pending rule proposal
  // per (human, scope). A repeat call answers the proposal already waiting
  // instead of filing N for the same decision. (No unique index backs this, so
  // two concurrent first calls can still both file — accepted, low priority.)
  const clusterKey = correctionClusterKey(input);
  const pending = await deps.findPendingForCluster(clusterKey);
  if (pending) return { proposalId: pending, alreadyProposed: true };
  const current = await deps.findCurrent(input.scope, input.userId);
  const data: StructureGuidelineProposalLike = {
    userId: input.userId,
    sourceId: input.userId,
    clusterKey,
    scopeKind: input.scope.scopeKind,
    scopeRef: input.scope.scopeRef ?? null,
    workspaceId: input.scope.workspaceId ?? null,
    text: appendCorrection(current, addition),
    addition,
    supersedesGuidelineId: current?.id ?? null,
    currentText: current?.text ?? null,
    evidence: {
      corrections: 1,
      proposals: 1,
      reasonHistogram: {},
      exampleReasons: [addition.replace(/\s+/g, " ").slice(0, 160)],
      sampleProposalIds: [input.sourceProposalId],
    },
  };
  const proposalId = await deps.fileProposal({
    data,
    workspaceId: data.workspaceId,
    userId: input.userId,
    agentUserId: input.agentUserId,
  });
  return { proposalId, alreadyProposed: false };
}

// ── Inferred: the governance.structure_guideline approval ───────────────────

/**
 * Which approval floor a `governance.*` proposal type gets. The ONE place the
 * structure-guideline exception is decided, so it can be tested and can never
 * widen a neighbouring type: exact match only.
 */
export function governanceApprovalFloorFor(
  proposalType: string
): "guideline-audience" | "pod-admin" | "none" {
  if (proposalType === STRUCTURE_GUIDELINE_PROPOSAL_TYPE) {
    return "guideline-audience";
  }
  // The unified gov-config door writes the SAME privileged rows the prefixed
  // `governance.*` meta-proposals do (`governance_rules` / `governance_ceilings`
  // / `config_settings`), and it is now what the recommenders file — but it
  // carries no `governance.` prefix, so the prefix rule below misses it. Without
  // this exact match the identical pod-wide row is pod-admin-only through the
  // legacy branch and approvable by ANY authenticated pod user through this one
  // (both review-authority helpers short-circuit on `workspaceId: null`).
  if (proposalType === "settings.update") return "pod-admin";
  if (proposalType.startsWith("governance.")) return "pod-admin";
  return "none";
}

export interface StructureGuidelineAuthorityDeps {
  isPodAdmin(userId: string): Promise<boolean>;
  workspaceRole(
    userId: string,
    workspaceId: string
  ): Promise<string | undefined>;
}

const authorityDbDeps: StructureGuidelineAuthorityDeps = {
  isPodAdmin,
  workspaceRole: getWorkspaceRole,
};

const WORKSPACE_GUIDELINE_APPROVER_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "editor",
]);

/**
 * Founder D1 — WHOEVER THE GUIDELINE APPLIES TO DECIDES.
 *   - pod-wide (owner-floored: it only ever applies to its owner) → the
 *     SUBJECT, or a pod admin;
 *   - workspace-scoped (biases every member) → a workspace owner/admin/editor,
 *     or a pod admin. Being the subject is NOT enough here.
 * Replaces the pod-admin floor for this ONE type only
 * (`governanceApprovalFloorFor`). FORBIDDEN otherwise.
 */
export async function assertCanApproveStructureGuideline(
  input: {
    userId: string;
    subjectUserId: string | null;
    workspaceId: string | null;
  },
  deps: StructureGuidelineAuthorityDeps = authorityDbDeps
): Promise<void> {
  if (input.workspaceId) {
    const role = await deps.workspaceRole(input.userId, input.workspaceId);
    if (role && WORKSPACE_GUIDELINE_APPROVER_ROLES.has(role)) return;
    if (await deps.isPodAdmin(input.userId)) return;
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "A workspace guideline applies to everyone in the workspace — a workspace editor or admin approves it.",
    });
  }
  if (input.subjectUserId && input.userId === input.subjectUserId) return;
  if (await deps.isPodAdmin(input.userId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "This guideline applies only to the person whose corrections produced it — they (or a pod admin) approve it.",
  });
}

/** Validate a stored payload; the subject floor defeats a revised `userId`. */
export function parseStructureGuidelineProposalData(
  payload: unknown,
  subjectUserId: string | null
): StructureGuidelineProposalData {
  const d = payload as Partial<StructureGuidelineProposalData> | null;
  const malformed = () =>
    new TRPCError({
      code: "BAD_REQUEST",
      message: "Malformed governance.structure_guideline proposal data.",
    });
  if (
    !d ||
    typeof d !== "object" ||
    typeof d.userId !== "string" ||
    typeof d.text !== "string" ||
    !d.text.trim() ||
    typeof d.addition !== "string" ||
    !d.addition.trim() ||
    !["default", "sourceKind", "entityKind"].includes(d.scopeKind as string)
  ) {
    throw malformed();
  }
  // The guideline is written AS the subject (owner floor), so the payload's
  // user must be the proposal's subject — a revise cannot redirect it.
  if (!subjectUserId || d.userId !== subjectUserId) throw malformed();
  return d as StructureGuidelineProposalData;
}

export type StructureGuidelineApprovalOutcome =
  | { kind: "applied"; guideline: ConfigSetting }
  | {
      kind: "rebase";
      data: StructureGuidelineProposalData;
      current: CurrentGuideline | null;
      reason: string;
    };

/**
 * Write the reviewed text as the next version — or say it must be re-based.
 *
 * The draft was made against ONE state of the guideline. If that state moved
 * (the version it supersedes was superseded or removed, or a guideline was
 * written at a scope that had none), writing the reviewed text would either
 * fail or silently overwrite text the reviewer never saw. Neither: report
 * `rebase` with the current row, and let the caller re-draft.
 *
 * `createdBy` is the SUBJECT, not the approving admin: a pod-wide guideline
 * only applies to its `created_by` (owner floor), so stamping the approver
 * would make an approved correction never apply to the person it came from.
 */
export async function applyStructureGuidelineApproval(
  input: {
    proposalId: string;
    subjectUserId: string | null;
    payload: unknown;
  },
  deps: GuidelineVersionDeps = guidelineVersionDbDeps
): Promise<StructureGuidelineApprovalOutcome> {
  const data = parseStructureGuidelineProposalData(
    input.payload,
    input.subjectUserId
  );
  const scope: CorrectionGuidelineScope = {
    scopeKind: data.scopeKind,
    scopeRef: data.scopeRef,
    workspaceId: data.workspaceId,
  };
  await assertScope(scope, deps);
  const text = assertTextFits(data.text);
  const source = `proposal:${input.proposalId}`;

  if (data.supersedesGuidelineId) {
    try {
      const guideline = await deps.supersede({
        id: data.supersedesGuidelineId,
        text,
        source,
        createdBy: data.userId,
      });
      return { kind: "applied", guideline };
    } catch (err) {
      if (!(err instanceof GuidelineSupersedeConflictError)) throw err;
      return {
        kind: "rebase",
        data,
        current: await deps.findCurrent(scope, data.userId),
        reason:
          err.reason === "not_current"
            ? "The guideline changed after this was proposed."
            : "The guideline this built on no longer exists.",
      };
    }
  }

  const current = await deps.findCurrent(scope, data.userId);
  if (current) {
    return {
      kind: "rebase",
      data,
      current,
      reason: "A guideline for this scope was written after this was proposed.",
    };
  }
  const guideline = await deps.create({
    scope,
    text,
    source,
    createdBy: data.userId,
  });
  return { kind: "applied", guideline };
}

/**
 * The re-drafted payload fields: the CURRENT guideline text plus ONLY the
 * evidence addition — never the stale draft, so no old text is duplicated. The
 * reviewer's edits to the stale draft are not carried (they were edits to text
 * that is no longer current); the reason says why the draft changed.
 */
export function rebasedStructureGuidelineFields(
  data: StructureGuidelineProposalData,
  current: CurrentGuideline | null,
  reason: string,
  now: Date
): Pick<
  StructureGuidelineProposalData,
  "text" | "supersedesGuidelineId" | "currentText" | "rebase"
> {
  const base = current?.text.trim();
  return {
    text: base ? `${base}\n\n${data.addition.trim()}` : data.addition.trim(),
    supersedesGuidelineId: current?.id ?? null,
    currentText: current?.text ?? null,
    rebase: {
      reason,
      at: now.toISOString(),
      previousSupersedesGuidelineId: data.supersedesGuidelineId,
    },
  };
}

export interface StructureGuidelineApprovalDeps extends GuidelineVersionDeps {
  markApproved(proposalId: string, reviewerId: string): Promise<void>;
  /** Back to PENDING with the re-drafted fields, through the shared revise core. */
  rebaseProposal(input: {
    proposalId: string;
    reviewerId: string;
    fields: Record<string, unknown>;
    reason: string;
  }): Promise<void>;
}

export const structureGuidelineApprovalDbDeps: StructureGuidelineApprovalDeps =
  {
    ...guidelineVersionDbDeps,
    async markApproved(proposalId, reviewerId) {
      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, proposalId));
    },
    // The ONE revise core: row lock, PENDING assertion (CONFLICT otherwise),
    // reviewer authority, and a `revisionHistory` entry recording the rebase.
    rebaseProposal: ({ proposalId, reviewerId, fields, reason }) =>
      mergeProposalRevision({
        proposalId,
        actorId: reviewerId,
        patch: { kind: "envelope", fields },
        reasoning: reason,
      }),
  };

/**
 * The whole `governance.structure_guideline` approve branch, so
 * `applyProposalApproval` keeps a few-line call. The router's own
 * `reportProposalOutcome` / `emitProposalReviewed` are passed in (importing
 * them from the router would be a cycle).
 *
 * Founder D2 — NEVER A DEAD END. When the guideline moved since the draft, the
 * proposal goes BACK TO PENDING with a re-drafted text (current + the evidence
 * addition), the reason recorded on the payload and in the revision history,
 * and a `reopened` notice so every client puts it back in the queue. The human
 * re-approves what they now see. Returns the registry's first-class no-op
 * receipt (`applied: "none"` + reason) — nothing was written, on purpose.
 */
export async function approveStructureGuidelineProposal(
  args: {
    proposal: {
      id: string;
      subjectUserId: string | null;
      workspaceId: string | null;
      sourceMessageId: string | null;
      agentUserId: string | null;
      targetType: string;
      proposalType: string;
      data: unknown;
    };
    reviewerId: string;
    payload: unknown;
    reportProposalOutcome: (params: {
      proposalId: string;
      outcome: "approved";
      sourceMessageId: string | null | undefined;
      agentUserId: string | null | undefined;
      targetType: string;
      proposalType: string;
      source?: string;
    }) => void;
    emitProposalReviewed: (
      proposalId: string,
      workspaceId: string | null | undefined,
      status: "approved" | "reopened",
      userId?: string
    ) => void;
  },
  deps: StructureGuidelineApprovalDeps = structureGuidelineApprovalDbDeps
) {
  const { proposal, reviewerId } = args;
  const outcome = await applyStructureGuidelineApproval(
    {
      proposalId: proposal.id,
      subjectUserId: proposal.subjectUserId,
      payload: args.payload,
    },
    deps
  );

  if (outcome.kind === "rebase") {
    await deps.rebaseProposal({
      proposalId: proposal.id,
      reviewerId,
      fields: rebasedStructureGuidelineFields(
        outcome.data,
        outcome.current,
        outcome.reason,
        new Date()
      ),
      reason: outcome.reason,
    });
    args.emitProposalReviewed(
      proposal.id,
      proposal.workspaceId,
      "reopened",
      reviewerId
    );
    return {
      success: true as const,
      effect: {
        applied: "none" as const,
        reason: `Not approved yet — ${outcome.reason} The draft now builds on the current guideline and is back in the queue to re-approve.`,
      },
    };
  }

  await deps.markApproved(proposal.id, reviewerId);
  args.reportProposalOutcome({
    proposalId: proposal.id,
    outcome: "approved",
    sourceMessageId: proposal.sourceMessageId,
    agentUserId: proposal.agentUserId,
    targetType: proposal.targetType,
    proposalType: proposal.proposalType,
    source: (proposal.data as Record<string, unknown> | null)?.source as
      string | undefined,
  });
  args.emitProposalReviewed(
    proposal.id,
    proposal.workspaceId,
    "approved",
    reviewerId
  );
  return {
    success: true as const,
    effect: {
      applied: "verified" as const,
      rows: outcome.guideline?.id ? 1 : 0,
      ...(outcome.guideline?.id ? { ids: [outcome.guideline.id] } : {}),
      subject: "config_settings(guideline)",
    },
  };
}
