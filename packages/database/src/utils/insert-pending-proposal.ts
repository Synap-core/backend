import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
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
  /** Optional explicit expiry. Omitted (or NULL) by default — proposals no
   *  longer auto-expire (see the C2 note at the INSERT below). */
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
  // A create's pre-generated primary id — `data.id ?? randomUUID()` mints a
  // fresh one per attempt (permission-check / capture door), which otherwise
  // poisons every create hash and makes create-dedup permanently inert. The id
  // is still STORED (the materializer reads it on approval); only the hash
  // ignores it, so two identical creates with different ids now hash equal.
  "id",
  // The chat/createProposal envelope ALSO folds a top-level `targetId` into the
  // stored payload (permission-check.ts: `data.id ?? randomUUID()` for creates),
  // a SECOND per-attempt poison. Strip it too — this is what actually revives
  // create-dedup for the chat path (the commonest case). SAFE for non-creates:
  // computeProposalDedupHash re-adds the real `targetId` ARG for update/delete/
  // attach and excludes it for creates, so identity is preserved either way.
  "targetId",
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
  // Normalize dotted proposalTypes ("entity.create", "note.create") to their
  // bare action verb before the create check. The generic Hub door
  // (POST /api/hub/proposals) passes the raw dotted `proposalType`, so keying
  // `isCreate` off the literal string "create" alone left create-dedup inert
  // there — the fresh per-attempt targetId leaked back into the hash.
  const action = p.proposalType.includes(".")
    ? p.proposalType.slice(p.proposalType.lastIndexOf(".") + 1)
    : p.proposalType;
  const isCreate = action === "create";
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

/** The subset of an insert input the dedup probe reads (hash + agent scope). */
export type PendingDuplicateProbe = Pick<
  InsertPendingProposalInput,
  "workspaceId" | "targetType" | "targetId" | "proposalType" | "data"
> & { agentUserId?: string | null };

/**
 * Peek for an existing PENDING proposal that exactly matches the proposed
 * change — the ONE dedup lookup both the door (permission-check /
 * event-backed-proposal, BEFORE stamping a `.requested` event) and the SSOT
 * insert below share.
 *
 * GLOBAL dedup (founder-ratified): the match is scoped by dedup_hash alone, NOT
 * by `agentUserId` — one pending proposal per normalized change across ALL
 * agents/automations. So if two different agents independently propose the
 * identical change, the second is deduped onto the first (returned here) rather
 * than colliding on the partial unique index and failing. This is what makes the
 * DB index (unique on `dedup_hash` where agent_user_id IS NOT NULL) and this peek
 * agree: the index is global, so the peek must be global too.
 *
 * Returns the matching row, or `null` when none exists / the write is
 * human-authored (no `agentUserId` — a person may deliberately file the same
 * change twice, and human rows carry NULL dedup_hash, are absent from the index,
 * and are never deduped).
 *
 * An index probe on the stored `dedup_hash` (not a scan-then-rehash), so the
 * candidate set is bounded by the partial unique index regardless of how many
 * pending proposals are open.
 */
export async function findExistingPendingDuplicate(
  input: PendingDuplicateProbe,
  executor: typeof db | DbTx = db
): Promise<typeof proposals.$inferSelect | null> {
  if (!input.agentUserId) return null;

  const dedupHash = computeProposalDedupHash({
    workspaceId: input.workspaceId,
    proposalType: input.proposalType,
    targetType: input.targetType,
    targetId: input.targetId,
    data: input.data,
  });

  const [existing] = await executor
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        eq(proposals.dedupHash, dedupHash)
      )
    )
    .limit(1);

  return existing ?? null;
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
  // payload, authored by the same agent), return it rather than inserting a
  // second row. Human-authored proposals (no agentUserId) are NEVER deduped.
  // Defense-in-depth: the callers already peek before stamping their
  // `.requested` event; this repeats the peek so the SSOT insert is safe for
  // every caller, and the 23505 catch below closes the concurrent-insert race
  // the read-then-insert peek can't (both racers peek empty, both insert, the
  // partial unique index rejects the loser).
  if (input.agentUserId) {
    const existing = await findExistingPendingDuplicate(input, executor);
    if (existing) return { proposal: existing, deduped: true };
  }

  // G3: persist the dedup hash for agent rows so the partial unique index can
  // enforce at-most-one PENDING agent proposal per normalized change. NULL for
  // human-authored proposals (never deduped, never constrained).
  const dedupHash = input.agentUserId
    ? computeProposalDedupHash({
        workspaceId: input.workspaceId,
        proposalType: input.proposalType,
        targetType: input.targetType,
        targetId: input.targetId,
        data: input.data,
      })
    : null;

  try {
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
        // C2 lifecycle-hygiene fix: no default TTL. A defaulted expiresAt used
        // to silently drop a proposal out of the actionable queue after
        // PROPOSAL_TTL_DAYS with no status change, no sweep, and no
        // notification — data that looked gone but was still counted by
        // `synap_orient`'s pending-review summary (a lying count). expiresAt
        // is now NULL unless a caller has a genuine reason to pass one.
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt }
          : {}),
        ...(dedupHash ? { dedupHash } : {}),
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
  } catch (err) {
    // Race enforcement: a concurrent identical write won the partial unique
    // index first (Postgres unique-violation, SQLSTATE 23505). Re-run the peek
    // and return the winner instead of surfacing the raw constraint error. The
    // peek is GLOBAL (dedup_hash only), so this recovers BOTH a same-agent race
    // and a different-agent identical write — whichever committed first is
    // returned as the dedup hit, never leaked as a 500 / false denial.
    const code = (err as { code?: string } | null)?.code;
    if (input.agentUserId && code === "23505") {
      const existing = await findExistingPendingDuplicate(input, executor);
      if (existing) return { proposal: existing, deduped: true };
    }
    throw err;
  }
}
