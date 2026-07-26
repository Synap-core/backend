import { randomUUID } from "crypto";
import { db, proposals, findExistingPendingDuplicate } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { auditLog } from "./audit-log.js";
import { createPendingProposal } from "./permission-check.js";

export interface CreateEventBackedProposalInput {
  userId: string;
  workspaceId?: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: Record<string, unknown>;
  action?: string;
  source?: string;
  summary?: string;
  agentUserId?: string | null;
  createdBy?: string | null;
  threadId?: string | null;
  commandRunId?: string | null;
  sourceMessageId?: string | null;
  sessionId?: string | null;
  /** Active project lens (or surface override) → proposals.project_id. At
   *  materialization this stamps `entity --belongs_to_project--> project`. */
  projectId?: string | null;
  expiresAt?: Date | null;
}

/**
 * The shared prefix of both proposal recorders: resolve the `correlationId`
 * (event-chain grouping within a proposal's lifecycle — NOT session linking,
 * which uses the sessionId FK), infer the action, stamp the `.requested` audit
 * event, and assemble the proposal `data` payload (folding in correlationId +
 * requestedEventId). The two public functions diverge only AFTER this.
 */
async function buildRequestedEventAndData(
  input: CreateEventBackedProposalInput
) {
  const correlationId =
    typeof input.data.correlationId === "string"
      ? input.data.correlationId
      : randomUUID();
  const action = input.action ?? inferProposalAction(input.proposalType);

  const requestedEvent = await auditLog({
    subjectType: input.targetType,
    action,
    phase: "requested",
    subjectId: input.targetId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? undefined,
    correlationId,
    source: input.source ?? "api",
    data: {
      ...input.data,
      proposalType: input.proposalType,
      summary: input.summary,
    },
  });

  const data = {
    ...input.data,
    ...(input.summary ? { summary: input.summary } : {}),
    correlationId,
    ...(requestedEvent?.id ? { requestedEventId: requestedEvent.id } : {}),
  };

  return { correlationId, action, requestedEvent, data };
}

export async function createEventBackedProposal(
  input: CreateEventBackedProposalInput
) {
  // G1 PEEK-BEFORE-EVENT: for an agent-authored write that exactly matches an
  // existing PENDING proposal, dedup is a NO-OP — return the existing proposal
  // WITHOUT stamping a spurious `.requested` audit event (buildRequestedEventAnd
  // Data below appends one; deduping AFTER that left it dangling on every agent
  // retry). The only fields buildRequestedEventAndData folds into `data`
  // (summary / correlationId / requestedEventId) are all VOLATILE dedup keys, so
  // the hash over `input.data` here matches what the SSOT insert stores.
  if (input.agentUserId) {
    const existing = await findExistingPendingDuplicate({
      workspaceId: input.workspaceId ?? null,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalType: input.proposalType,
      data: input.data,
      agentUserId: input.agentUserId,
    });
    if (existing) {
      const correlationId =
        typeof input.data.correlationId === "string"
          ? input.data.correlationId
          : (existing.correlationId ?? randomUUID());
      return { proposal: existing, requestedEvent: null, correlationId };
    }
  }

  const { correlationId, requestedEvent, data } =
    await buildRequestedEventAndData(input);

  const proposal = await createPendingProposal({
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    targetType: input.targetType,
    targetId: input.targetId,
    proposalType: input.proposalType,
    data,
    agentUserId: input.agentUserId,
    createdBy: input.createdBy,
    threadId: input.threadId,
    commandRunId: input.commandRunId,
    sourceMessageId: input.sourceMessageId,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    expiresAt: input.expiresAt,
    notificationDescription: input.summary,
  });

  return { proposal, requestedEvent, correlationId };
}

export interface CreateAutoApprovedProposalInput extends CreateEventBackedProposalInput {
  /** The user who performed (and is implicitly approving) the already-done write. */
  reviewedBy: string;
}

/**
 * Record an ALREADY-DONE first-party write as a persistent `auto_approved`
 * proposal row, for traceability + revert.
 *
 * Mirror of `createEventBackedProposal` (same `.requested` audit stamp + the
 * same `{ ...data, correlationId, requestedEventId, summary }` payload shape),
 * EXCEPT:
 *   - it inserts the proposals row directly with `status: 'auto_approved'`
 *     (createPendingProposal hardcodes PENDING + can't stamp reviewedBy/reviewedAt),
 *   - it stamps `reviewedBy` + `reviewedAt: now`,
 *   - it writes a SECOND `.completed` audit event so the timeline reads
 *     requested → completed (the write already happened — there is no pending gap).
 *
 * This does NOT go through `checkPermissionOrPropose`: the write is a first-party
 * human action that is already committed; we are RECORDING it, not asking
 * permission. Callers should treat it as best-effort (a recording hiccup must
 * never fail the underlying operation).
 */
export async function createAutoApprovedProposal(
  input: CreateAutoApprovedProposalInput
) {
  const { correlationId, action, requestedEvent, data } =
    await buildRequestedEventAndData(input);

  const reviewedAt = new Date();

  const [proposal] = await db
    .insert(proposals)
    .values({
      workspaceId: input.workspaceId ?? null,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalType: input.proposalType,
      data,
      status: ProposalStatus.AUTO_APPROVED,
      createdBy: input.createdBy ?? input.agentUserId ?? input.userId,
      reviewedBy: input.reviewedBy,
      reviewedAt,
      // C2 lifecycle-hygiene fix: no default TTL — this row is already
      // terminal (auto_approved), so a synthetic expiry never did anything
      // useful. See the matching note in `insertPendingProposal`.
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.commandRunId ? { commandRunId: input.commandRunId } : {}),
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
      correlationId,
      ...(requestedEvent?.id ? { requestedEventId: requestedEvent.id } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    })
    .returning();

  // Second stamp: the write already happened, so the lifecycle is
  // requested → completed (no pending review gap). Coherent timeline.
  const completedEvent = await auditLog({
    subjectType: input.targetType,
    action,
    phase: "completed",
    subjectId: input.targetId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? undefined,
    correlationId,
    source: input.source ?? "api",
    data: {
      ...input.data,
      proposalType: input.proposalType,
      summary: input.summary,
      proposalId: proposal?.id,
      autoApproved: true,
    },
  });

  return { proposal, requestedEvent, completedEvent, correlationId };
}

function inferProposalAction(proposalType: string): string {
  const parts = proposalType.split(".");
  return parts[1] || parts[0] || "update";
}
