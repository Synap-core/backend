/**
 * Blocked-Slot Recurrence Scanner — turns a REPEATED block into a proposal for
 * the guideline that would explain it next time.
 *
 * An agent that cannot take a deliverable hands the slot to the human with a
 * typed `blockedReason` and a one-line `why`. One such block is just work. The
 * SAME block, arriving again and again across different sessions, is a missing
 * piece of standing intent — and that is what this scanner looks for.
 *
 * GENERALISED FROM `governance-lane-scanner.ts`, deliberately and structurally:
 * a daily cron, structural-fingerprint clustering, an N-threshold, two duplicate
 * guards (nothing already PENDING, nothing already COVERING), and — the property
 * that matters most — it only ever FILES A PENDING PROPOSAL. It never writes a
 * guideline itself. The one place a `config_settings` guideline is created from
 * one of these is the `governance.work_guideline` branch in
 * `packages/api/src/routers/proposals/apply-approval.ts`, on human approval.
 * That is the same division `governance.widen_lane` and
 * `governance.tighten_posture` already keep.
 *
 * ── THE THRESHOLD IS UNVALIDATED, AND MUST STAY LABELLED SO ─────────────────
 * `N >= 3 distinct slots across >= 2 distinct sessions within 30 days`. No
 * source measures whether N-recurrence beats acting on a FIRST occurrence — the
 * comparison has not been run, here or in the literature, so these constants are
 * a HYPOTHESIS WITH A KNOB, not a finding. Do not cite them as evidence. What
 * is NOT speculative is the alternative: offering a remedy on every first block
 * is the configuration measured at +0.0pp for LLM-authored library entries.
 * Instrument these numbers before tuning them.
 *
 * ── WHY ONLY `capability` AND `credential` ──────────────────────────────────
 * `permission` is EXCLUDED from this wave on purpose: a recurrence proposal for
 * it is the agent arguing for its own power, and one over-broad approval
 * propagates silently. It also needs no new machinery when its turn comes
 * (`governance.widen_lane` already exists). `policy`'s remedy is editing a rule
 * a human already wrote — an existing door. `decision` and `physical` are
 * honestly terminal: a human has to choose, or act in the world. Proposing a
 * remedy for a terminal reason would manufacture busywork out of an honest stop.
 *
 * ── LAYERING ────────────────────────────────────────────────────────────────
 * `@synap/jobs` cannot import `@synap/api` (api depends on jobs, not the
 * reverse), so the owed-slot predicate below is a deliberate, minimal MIRROR of
 * `packages/api/src/services/focus-sessions/owed-outputs.ts` — the same
 * `owner='human' AND status IS DISTINCT FROM 'done' AND retiredAt IS NULL`
 * triple, including the `IS DISTINCT FROM`, which is load-bearing: `status` is
 * ABSENT on most owed slots and `!= 'done'` yields NULL and drops the row.
 * Keep the two in sync — the same arrangement the fingerprint mirror in
 * `governance-lane-scanner.ts` documents.
 *
 * Queue: blocked-slot.recurrence-scan
 * Cron:  daily 50 3 * * * (after librarian-archiver at 3:45)
 */

import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  focusSessions,
  configSettings,
  proposals,
  insertPendingProposal,
  ProposalStatus,
  GUIDELINE_KEY,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";

const logger = createLogger({ module: "blocked-slot-recurrence-scanner" });

export const BLOCKED_SLOT_RECURRENCE_QUEUE = "blocked-slot.recurrence-scan";

/** Daily, after librarian-archiver (3:45). */
export const BLOCKED_SLOT_RECURRENCE_CRON = "50 3 * * *";

/**
 * The proposal type. Prefixed `governance.` deliberately: `applyProposalApproval`
 * gates every `governance.*` type behind `assertPodAdmin`, and a standing rule
 * that shapes how an agent interprets a whole class of work deserves that floor.
 * The cost is that on a MULTI-user pod a non-admin's recurring blocks are
 * proposed but only an admin can approve them; on a single-owner pod (the
 * common case) the owner is the admin. Recorded rather than silently chosen.
 */
export const WORK_GUIDELINE_PROPOSAL_TYPE = "governance.work_guideline";

/**
 * The `governance.work_guideline` payload. Mirrors the local-declaration
 * convention of `GovernanceWidenLaneProposalData` in the lane scanner: jobs
 * cannot import the api package, so the approval-branch consumer keeps its own
 * copy of this interface and the two are kept in sync by hand.
 */
export interface WorkGuidelineProposalData {
  /** The human this block keeps landing on — the guideline's owner. */
  userId: string;
  /** `scopeKind:'workKind'` scopeRef: one of BLOCKED_REASONS. */
  blockedReason: string;
  /** Suggested guideline text. EDITABLE by the reviewer before approving. */
  text: string;
  /** NULL = pod-wide (owner-floored on read). */
  workspaceId?: string | null;
  evidence: {
    /** How many owed slots fell in this cluster. */
    occurrences: number;
    /** Across how many DISTINCT sessions. */
    sessions: number;
    /** The `why` (or label) line the cluster keyed on. */
    signature: string;
    windowDays: number;
    sampleSessionIds: string[];
  };
}

// ── The knobs. UNVALIDATED — see the file header. ───────────────────────────

/** Distinct owed slots needed before a cluster is proposed. UNVALIDATED. */
const MIN_OCCURRENCES = 3;
/**
 * Distinct sessions needed. UNVALIDATED — but not redundant with
 * MIN_OCCURRENCES: three slots inside ONE session is one piece of work that
 * stalled three ways, not a recurring pattern.
 */
const MIN_SESSIONS = 2;
/** Lookback. UNVALIDATED. */
const WINDOW_DAYS = 30;

/**
 * The reasons a remedy proposal is even meaningful. See the header for why the
 * other four are excluded — each exclusion is a decision, not an oversight.
 */
export const REMEDIABLE_BLOCKED_REASONS = ["capability", "credential"] as const;

/** Bound on sessions scanned per pass, mirroring the lane scanner's SCAN_LIMIT. */
const SCAN_LIMIT = 2000;

// ── Pure clustering (unit-testable, DB-free) ────────────────────────────────

/** One owed, blocked slot, flattened out of its session. */
export interface BlockedSlotRow {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
  blockedReason: string;
  why?: string;
  label: string;
  /** ISO-8601 UTC, as `owedSince` is always written. */
  owedSince: string;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The cluster key. `blockedReason` × the line that says WHICH thing is missing.
 *
 * `why` is the discriminator when present ("the Stripe restricted key for the
 * live account"); `label` is the fallback. The two are PREFIXED so they can
 * never collide into one namespace — the same `name:` / `id:` discipline
 * `computeProposalFingerprint` uses, and the reason `guideline.appliesTo`'s
 * undiscriminated free text was unreadable.
 *
 * `label` is deliberately NOT part of the key when `why` exists: the label is
 * the deliverable's name and differs per session, which would split every
 * cluster into singletons and guarantee the scanner never fires.
 */
export function computeBlockedSlotFingerprint(slot: BlockedSlotRow): string {
  const why = slot.why?.trim();
  const signature = why
    ? `why:${normalizeToken(why)}`
    : `label:${normalizeToken(slot.label ?? "")}`;
  return `${slot.blockedReason}\0${signature}`;
}

export interface BlockedSlotCluster {
  key: string;
  userId: string;
  workspaceId: string | null;
  blockedReason: string;
  signature: string;
  occurrences: number;
  sessionIds: string[];
}

/**
 * Cluster owed blocked slots per (user, blockedReason, signature) and keep only
 * the ones that clear BOTH thresholds. Pure — the thresholds are testable
 * without a database, which is the point of the split.
 */
export function clusterBlockedSlots(
  slots: BlockedSlotRow[]
): BlockedSlotCluster[] {
  const byKey = new Map<string, BlockedSlotCluster>();
  for (const slot of slots) {
    if (
      !(REMEDIABLE_BLOCKED_REASONS as readonly string[]).includes(
        slot.blockedReason
      )
    ) {
      continue;
    }
    const fingerprint = computeBlockedSlotFingerprint(slot);
    // Scoped per USER: `focus_sessions` is owner-private, so two people's
    // identical blocks are two patterns, never one.
    const key = `${slot.userId}\0${fingerprint}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.sessionIds.includes(slot.sessionId)) {
        existing.sessionIds.push(slot.sessionId);
      }
      // A cluster spanning workspaces is pod-wide: a guideline scoped to one
      // workspace would silently not apply to the sessions in the others.
      if (existing.workspaceId !== slot.workspaceId) {
        existing.workspaceId = null;
      }
      continue;
    }
    byKey.set(key, {
      key,
      userId: slot.userId,
      workspaceId: slot.workspaceId,
      blockedReason: slot.blockedReason,
      signature: fingerprint.split("\0")[1] ?? "",
      occurrences: 1,
      sessionIds: [slot.sessionId],
    });
  }

  return [...byKey.values()].filter(qualifiesForRemedy);
}

/** The pure threshold gate — the ONE place the knobs are applied. */
export function qualifiesForRemedy(cluster: BlockedSlotCluster): boolean {
  return (
    cluster.occurrences >= MIN_OCCURRENCES &&
    cluster.sessionIds.length >= MIN_SESSIONS
  );
}

/**
 * The DRAFT guideline text. It is a draft on purpose: the reviewer edits it
 * before approving. An artifact a human only rubber-stamps is the configuration
 * measured at +0.0pp; one a human edits is the +16.2pp condition.
 */
export function draftGuidelineText(cluster: BlockedSlotCluster): string {
  const what = cluster.signature.replace(/^(why|label):/, "");
  return (
    `Work has been blocked on a ${cluster.blockedReason} ${cluster.occurrences} times ` +
    `across ${cluster.sessionIds.length} sessions (${what}). ` +
    `Describe here what the agent should do instead of stopping.`
  );
}

// ── DB tier ──────────────────────────────────────────────────────────────────

/**
 * Every owed, blocked slot in the window, flattened in SQL.
 *
 * `jsonb_array_elements` ERRORS on a non-array value and `expected_outputs` is
 * untyped JSONB a legacy row can hold anything in, so the `jsonb_typeof` guard
 * is the same one `owed-outputs.ts` carries in production — not defensive
 * padding.
 *
 * The window is applied to `owedSince` (when the slot became the human's), NOT
 * to the session's timestamps: a block accumulates on OLD, CLOSED sessions, so
 * filtering by session age would hide exactly the population this scanner is
 * for.
 */
async function loadBlockedSlots(): Promise<BlockedSlotRow[]> {
  const cutoff = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = (await db.execute(drizzleSql`
    SELECT
      ${focusSessions.id}          AS session_id,
      ${focusSessions.userId}      AS user_id,
      ${focusSessions.workspaceId} AS workspace_id,
      slot->>'blockedReason'       AS blocked_reason,
      slot->>'why'                 AS why,
      slot->>'label'               AS label,
      slot->>'owedSince'           AS owed_since
    FROM ${focusSessions},
    LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(${focusSessions.expectedOutputs}) = 'array'
           THEN ${focusSessions.expectedOutputs}
           ELSE '[]'::jsonb END
    ) AS slot
    WHERE slot->>'owner' = 'human'
      AND slot->>'status' IS DISTINCT FROM 'done'
      AND slot->>'retiredAt' IS NULL
      AND slot->>'blockedReason' IS NOT NULL
      AND slot->>'owedSince' >= ${cutoff}
    LIMIT ${SCAN_LIMIT}
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    sessionId: String(r.session_id),
    userId: String(r.user_id),
    workspaceId: (r.workspace_id as string | null) ?? null,
    blockedReason: String(r.blocked_reason),
    ...(typeof r.why === "string" ? { why: r.why } : {}),
    label: typeof r.label === "string" ? r.label : "",
    owedSince: String(r.owed_since),
  }));
}

/**
 * GUARD 1 — an equivalent proposal is already waiting for this human.
 *
 * Keyed on the payload, not on `proposals.agentUserId`: the scanner authors
 * these, so the subject lives in `data` — exactly as
 * `hasPendingWidenProposal` reads it.
 */
async function hasPendingProposal(
  cluster: BlockedSlotCluster
): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, WORK_GUIDELINE_PROPOSAL_TYPE),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows.some((r) => {
    const data = r.data as Partial<WorkGuidelineProposalData> | null;
    return (
      data?.userId === cluster.userId &&
      data?.blockedReason === cluster.blockedReason
    );
  });
}

/**
 * GUARD 2 — a `workKind` guideline for this reason is already ACTIVE in this
 * human's lens, so the standing intent has already been written and a second
 * proposal would be noise.
 *
 * Deliberately COARSE: it matches on the `blockedReason` scopeRef alone, not on
 * the cluster's signature, because the guideline carries no signature to match.
 * Erring toward "already covered" skips a proposal; erring the other way spams
 * the queue, which is what kills a recommender.
 */
async function hasCoveringGuideline(
  cluster: BlockedSlotCluster
): Promise<boolean> {
  const rows = await db
    .select({ id: configSettings.id })
    .from(configSettings)
    .where(
      and(
        eq(configSettings.key, GUIDELINE_KEY),
        eq(configSettings.scopeKind, "workKind"),
        eq(configSettings.scopeRef, cluster.blockedReason),
        eq(configSettings.createdBy, cluster.userId),
        isNull(configSettings.revokedAt)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function proposeRemedy(cluster: BlockedSlotCluster): Promise<void> {
  if (await hasPendingProposal(cluster)) return;
  if (await hasCoveringGuideline(cluster)) return;

  const data: WorkGuidelineProposalData = {
    userId: cluster.userId,
    blockedReason: cluster.blockedReason,
    text: draftGuidelineText(cluster),
    workspaceId: cluster.workspaceId,
    evidence: {
      occurrences: cluster.occurrences,
      sessions: cluster.sessionIds.length,
      signature: cluster.signature,
      windowDays: WINDOW_DAYS,
      sampleSessionIds: cluster.sessionIds.slice(0, 5),
    },
  };

  const { proposal } = await insertPendingProposal({
    workspaceId: cluster.workspaceId,
    targetType: "governance",
    targetId: cluster.userId,
    proposalType: WORK_GUIDELINE_PROPOSAL_TYPE,
    data: data as unknown as Record<string, unknown>,
    createdBy: cluster.userId,
    proposedByUserId: null,
    // OWNER FLOOR (0248): the human these blocks land on decides.
    subjectUserId: cluster.userId,
  });

  void emitSideEffects({
    subjectType: "proposal",
    action: "created",
    subjectId: proposal.id,
    userId: cluster.userId,
    data: {
      proposalStatus: "created",
      targetType: "governance",
      changeType: WORK_GUIDELINE_PROPOSAL_TYPE,
    },
  }).catch((err) => {
    logger.warn(
      { err, proposalId: proposal.id },
      "blocked-slot-recurrence-scanner: emitSideEffects failed (non-fatal)"
    );
  });

  logger.info(
    {
      userId: cluster.userId,
      blockedReason: cluster.blockedReason,
      occurrences: cluster.occurrences,
      sessions: cluster.sessionIds.length,
    },
    "blocked-slot-recurrence-scanner: filed work_guideline proposal"
  );
}

/**
 * Cron / on-demand handler. Manual trigger:
 * `await boss.send("blocked-slot.recurrence-scan", {})`
 *
 * Resilient per-cluster: one cluster's failure never aborts the batch.
 */
export async function handleBlockedSlotRecurrenceScan(): Promise<void> {
  logger.info("blocked-slot-recurrence-scanner: starting scan");

  const slots = await loadBlockedSlots();
  const clusters = clusterBlockedSlots(slots);
  let failed = 0;

  for (const cluster of clusters) {
    try {
      await proposeRemedy(cluster);
    } catch (err) {
      failed += 1;
      logger.error(
        { err, key: cluster.key },
        "blocked-slot-recurrence-scanner: failed for cluster, skipping"
      );
    }
  }

  logger.info(
    { slots: slots.length, clusters: clusters.length, failed },
    "blocked-slot-recurrence-scanner: scan complete"
  );
}
