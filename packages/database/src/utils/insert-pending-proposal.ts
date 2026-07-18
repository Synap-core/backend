import { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
import { PROPOSAL_TTL_DAYS } from "@synap/governance-policy";

/**
 * The canonical PENDING-proposal row INSERT.
 *
 * This is the ONE place the `proposals` row shape for a pending proposal is
 * written — status, TTL/expiry default, and the conditional provenance spreads
 * (agentUserId / thread / commandRun / sourceMessage / correlation /
 * requestedEvent / session / project). Both writers call it:
 *   - `createPendingProposal` (in @synap/api's permission-check) — the
 *     `checkPermissionOrPropose` chat-AI path.
 *   - `proposeAutomationWrite` (in @synap/jobs's automation-governance) — the
 *     automation write path.
 *
 * Lives in @synap/database (not @synap/api) because @synap/api depends on
 * @synap/jobs (api → jobs), so a shared helper in api would be a circular
 * import for the jobs writer. Pushed down here — next to `openRunSession` —
 * both layers import it, and the hand-mirrored INSERT that used to live in
 * automation-governance.ts (with its documented drift risk) is deleted.
 *
 * This function OWNS only the INSERT. Each caller keeps its own post-insert
 * side effects (createPendingProposal → notifyProposalCreated; proposeAutomation
 * Write → its automation-specific broadcast + emitSideEffects) because those
 * differ between the two paths and are not part of the persisted-row fork.
 */

/** Drizzle transaction handle — same insert surface as `db`. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface InsertPendingProposalInput {
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  /** Payload — the caller builds the full stored `data` object. */
  data: Record<string, unknown>;
  /** Author of the row. Callers resolve their own fallback before calling. */
  createdBy: string | null;
  /** The HUMAN userId that filed this proposal (NULL for agent-authored rows). */
  proposedByUserId?: string | null;
  agentUserId?: string | null;
  threadId?: string | null;
  commandRunId?: string | null;
  sourceMessageId?: string | null;
  correlationId?: string | null;
  requestedEventId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  /** Workflow attribution (D3a): the automation step run + flow node that
   *  produced this proposal. Both optional — non-automation proposals omit them. */
  stepRunId?: string | null;
  nodeId?: string | null;
  /** Explicit expiry; defaults to now + PROPOSAL_TTL_DAYS when omitted. */
  expiresAt?: Date | null;
}

/**
 * Insert a single PENDING `proposals` row and return the full inserted row.
 *
 * @param executor Optional transaction handle. When the caller is already
 *   inside a `db.transaction`, pass the tx so the INSERT joins it; otherwise the
 *   shared `db` connection is used.
 */
export async function insertPendingProposal(
  input: InsertPendingProposalInput,
  executor: typeof db | DbTx = db
): Promise<typeof proposals.$inferSelect> {
  const [proposal] = await executor
    .insert(proposals)
    .values({
      workspaceId: input.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalType: input.proposalType,
      data: input.data,
      status: ProposalStatus.PENDING,
      createdBy: input.createdBy,
      expiresAt:
        input.expiresAt ??
        new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000),
      ...(input.proposedByUserId
        ? { proposedByUserId: input.proposedByUserId }
        : {}),
      ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.commandRunId ? { commandRunId: input.commandRunId } : {}),
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.requestedEventId
        ? { requestedEventId: input.requestedEventId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    })
    .returning();

  return proposal;
}
