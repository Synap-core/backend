import { createHash } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
import { PROPOSAL_TTL_DAYS } from "@synap/governance-policy";
import { stableStringify } from "./stable-stringify.js";

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
  /** Workflow attribution: the automation step run + flow node that
   *  produced this proposal. Both optional — non-automation proposals omit them. */
  stepRunId?: string | null;
  nodeId?: string | null;
  /** Explicit expiry; defaults to now + PROPOSAL_TTL_DAYS when omitted. */
  expiresAt?: Date | null;
}

export interface InsertPendingProposalResult {
  /** The pending `proposals` row — freshly inserted, OR the pre-existing
   *  identical one when `deduped` is true. */
  proposal: typeof proposals.$inferSelect;
  /**
   * True when an identical PENDING proposal already existed and was returned
   * instead of inserting a duplicate. Only ever true for agent/automation-
   * authored proposals (see the guard in `insertPendingProposal`); human-authored
   * proposals are never deduped. Lets the caller skip the "created" notification
   * and tell the agent it already proposed this.
   */
  deduped: boolean;
}

/**
 * Payload keys that vary between two attempts to propose the SAME change — fresh
 * request/correlation ids, per-run ids, the freshly-appended `.requested` event
 * id, LLM-authored prose (reasoning/summary), and the before-snapshot context.
 * They are envelope/plumbing, NOT the proposed change, so the dedup hash strips
 * them; otherwise every retry would hash differently and dedup could never fire.
 */
const VOLATILE_DEDUP_KEYS = new Set([
  "requestId",
  "correlationId",
  "requestedEventId",
  "automationRunId",
  "reasoning",
  "summary",
  "previousData",
  "targetName",
]);

/**
 * Canonical exact-match dedup hash for a pending proposal:
 *   sha256( stableStringify({ workspaceId, proposalType, targetType,
 *                             targetId?, payload }) )
 *
 * - `targetId` is INCLUDED for real-target actions (update/delete/attach/…) where
 *   it identifies the thing being changed, and EXCLUDED for `create` — a create's
 *   targetId is a fresh randomUUID per attempt (permission-check builds it as
 *   `data.id ?? randomUUID()`), so hashing it would make every retry unique and
 *   defeat dedup entirely.
 * - `payload` is the stored `data` with the per-attempt VOLATILE_DEDUP_KEYS
 *   stripped, then key-sorted by stableStringify — so two identical proposals
 *   built in a different key order still hash equal.
 */
export function computeProposalDedupHash(p: {
  workspaceId: string | null;
  proposalType: string;
  targetType: string;
  targetId: string;
  data: Record<string, unknown>;
}): string {
  const isCreate = p.proposalType === "create";
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(p.data)) {
    if (VOLATILE_DEDUP_KEYS.has(key)) continue;
    payload[key] = p.data[key];
  }
  const canonical = {
    workspaceId: p.workspaceId ?? null,
    proposalType: p.proposalType,
    targetType: p.targetType,
    ...(isCreate ? {} : { targetId: p.targetId }),
    payload,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/**
 * Insert a single PENDING `proposals` row, or — for an agent/automation-authored
 * proposal that exactly matches an existing PENDING one — return that existing
 * row without inserting a duplicate. Result is `{ proposal, deduped }`.
 *
 * @param executor Optional transaction handle. When the caller is already
 *   inside a `db.transaction`, pass the tx so both the dedup SELECT and the
 *   INSERT join it; otherwise the shared `db` connection is used.
 */
export async function insertPendingProposal(
  input: InsertPendingProposalInput,
  executor: typeof db | DbTx = db
): Promise<InsertPendingProposalResult> {
  // DEDUP GUARD (agent/automation-authored only): prevent a duplicate pending
  // proposal at the door instead of creating-then-rejecting. When an identical
  // PENDING proposal already exists (same workspace + type + target + normalized
  // payload, authored by the same agent, within the proposal TTL), return it
  // rather than inserting a second row. Human-authored proposals (no
  // agentUserId) are NEVER deduped — a person may deliberately file the same
  // change twice. Exact-match by hash; hashed at read (no stored column / index
  // this wave — a stored hash + unique index is the future optimization once
  // candidate sets grow, and would also close the concurrent-insert race that
  // read-then-insert leaves open for simultaneous duplicates).
  if (input.agentUserId) {
    const isCreate = input.proposalType === "create";
    const ttlFloor = new Date(
      Date.now() - PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000
    );
    const candidates = await executor
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.status, ProposalStatus.PENDING),
          input.workspaceId == null
            ? isNull(proposals.workspaceId)
            : eq(proposals.workspaceId, input.workspaceId),
          eq(proposals.proposalType, input.proposalType),
          eq(proposals.targetType, input.targetType),
          eq(proposals.agentUserId, input.agentUserId),
          // A create's targetId is a fresh randomUUID per attempt, so filtering by
          // it would never match a prior attempt — narrow by it only for real
          // targets (update/delete/attach/…).
          ...(isCreate ? [] : [eq(proposals.targetId, input.targetId)]),
          gt(proposals.createdAt, ttlFloor)
        )
      );

    const incomingHash = computeProposalDedupHash({
      workspaceId: input.workspaceId,
      proposalType: input.proposalType,
      targetType: input.targetType,
      targetId: input.targetId,
      data: input.data,
    });
    for (const candidate of candidates) {
      const candidateHash = computeProposalDedupHash({
        workspaceId: candidate.workspaceId,
        proposalType: candidate.proposalType,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        data: (candidate.data ?? {}) as Record<string, unknown>,
      });
      if (candidateHash === incomingHash) {
        return { proposal: candidate, deduped: true };
      }
    }
  }

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

  return { proposal, deduped: false };
}
