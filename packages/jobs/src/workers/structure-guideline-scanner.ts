/**
 * Structure-Guideline Scanner — turns a REPEATED, REASONED extraction
 * correction into ONE proposal for the guideline that would prevent it.
 *
 * The feedback loop's inferred half (intake plan §3.4 / W5; founder decision:
 * "an INFERRED pattern → ONE proposal the user reviews", corrections become
 * VERSIONED guideline text, never opaque memory). A human rejecting an
 * extracted item WITH a reason is the richest correction signal the pod has
 * (B14 — it used to dead-end). One such reject is just review. The same kind of
 * reject, on the same data type, across several captures/imports, is a missing
 * guideline.
 *
 * CLONED FROM `blocked-slot-recurrence-scanner.ts` (itself generalised from
 * `governance-lane-scanner.ts` / `recommend-tighten.ts`): a daily cron,
 * clustering, an N-threshold, duplicate guards, and — the property that
 * matters — it only ever FILES A PENDING PROPOSAL. The one place a guideline is
 * written from one of these is `approveStructureGuidelineProposal`
 * (`packages/api/src/services/guidelines/guideline-versions.ts`), reached from
 * `applyProposalApproval` on human approval.
 *
 * ── WHO APPROVES (founder D1) ────────────────────────────────────────────────
 * Whoever the guideline applies to decides: a pod-wide (owner-floored)
 * guideline is approvable by its SUBJECT — the human whose corrections produced
 * it — or a pod admin; a workspace-scoped one needs a workspace editor/admin
 * (or a pod admin). The payload carries `sourceId` = the subject so the approve
 * door's ownership rung admits them; `applyProposalApproval` applies the
 * audience floor in place of the pod-admin floor every other `governance.*`
 * type keeps.
 *
 * ── WHY PROPOSALS, NOT `ai_correction` EVENTS ────────────────────────────────
 * The events spine carries the same reasons, but a per-item reject is emitted
 * TWICE: once by `proposals.rejectItem` at deny time (`reject_item`) and again
 * by `applyProposalApproval` for every rejected disposition at approve time.
 * Counting events would double every per-item correction. The proposal row is
 * the durable source both emitters read from — `reasonCode`/`rejectionReason`
 * for a whole-proposal reject, `data.dispositions[ref]` for an item — so this
 * scanner reads the row, once.
 *
 * ── SCOPE: ONE rung per correction, most specific first ─────────────────────
 *   - an item reject whose op is a `create_entity` → `entityKind:<profileSlug>`
 *   - otherwise an `import.graph` → `sourceKind:import:<source>`
 *   - otherwise → `default` (the workspace lens; a capture.graph carries no
 *     input kind today — `data.source` is the producer, not the input)
 * One rung per correction means one set of rejects can never file two
 * overlapping proposals.
 *
 * ── EXCLUDED REASONS ─────────────────────────────────────────────────────────
 *   - `wrong_workspace` — a ROUTING fault; routing memory owns it.
 *   - `duplicate` — a MECHANICAL fault (see `reason-bucket.ts`): the remedy is
 *     an existence check, and a guideline cannot deduplicate.
 * An UNREASONED reject is not evidence here (never fabricated).
 *
 * ── THE THRESHOLD IS UNVALIDATED ─────────────────────────────────────────────
 * `>= 3 reasoned corrections across >= 2 distinct proposals within 30 days` is a
 * hypothesis with a knob, mirroring the blocked-slot scanner. Instrument before
 * tuning.
 *
 * ── RE-FILING ────────────────────────────────────────────────────────────────
 * Only on NEW evidence. A cluster with a PENDING proposal is skipped. Otherwise
 * only corrections decided AFTER the `createdAt` of the cluster's most recent
 * proposal (any status — a rejected proposal is a human "no", not an invitation
 * to re-ask tomorrow) AND after the `createdAt` of the current covering
 * guideline row count.
 *
 * ── LAYERING ─────────────────────────────────────────────────────────────────
 * `@synap/jobs` cannot import `@synap/api`. The payload type, the proposal type,
 * the text cap and the current-guideline lookup are the SHARED declarations in
 * `@synap/database` (`utils/config-settings.ts`); only the reason-bucket
 * precedence is hand-mirrored (api `reason-bucket.ts`).
 *
 * Queue: structure-guideline.scan
 * Cron:  daily 55 3 * * * (after the blocked-slot scanner at 3:50)
 */

import {
  db,
  and,
  eq,
  gte,
  desc,
  inArray,
  or,
  drizzleSql,
  proposals,
  insertPendingProposal,
  findCurrentGuideline,
  ProposalStatus,
  GUIDELINE_TEXT_MAX,
  STRUCTURE_GUIDELINE_PROPOSAL_TYPE,
  type CurrentGuideline,
  type StructureGuidelineProposalData,
  type StructureGuidelineScopeKind,
} from "@synap/database";
import {
  PROPOSAL_REJECTION_REASONS,
  IMPORT_SOURCE_VALUES,
} from "@synap-core/types";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";

const logger = createLogger({ module: "structure-guideline-scanner" });

export const STRUCTURE_GUIDELINE_SCAN_QUEUE = "structure-guideline.scan";

/** Daily, after the blocked-slot recurrence scanner (3:50). */
export const STRUCTURE_GUIDELINE_SCAN_CRON = "55 3 * * *";

/** The extraction proposal types whose rejects are structure corrections. */
export const EXTRACTION_PROPOSAL_TYPES = [
  "capture.graph",
  "import.graph",
] as const;

// ── The knobs. UNVALIDATED — see the header. ────────────────────────────────

const MIN_CORRECTIONS = 3;
/** Not redundant: three rejects inside ONE capture is one bad capture. */
const MIN_PROPOSALS = 2;
const WINDOW_DAYS = 30;
const SCAN_LIMIT = 2000;

const EXCLUDED_REASONS: ReadonlySet<string> = new Set([
  "wrong_workspace",
  "duplicate",
]);

const KNOWN_REASON_CODES: ReadonlySet<string> = new Set(
  PROPOSAL_REJECTION_REASONS
);

// ── Pure tier (unit-testable, DB-free) ──────────────────────────────────────

/** One decided extraction proposal, as the scanner reads it. */
export interface ExtractionProposalRow {
  id: string;
  proposalType: string;
  status: string;
  userId: string | null;
  workspaceId: string | null;
  reasonCode: string | null;
  rejectionReason: string | null;
  data: unknown;
  decidedAt: Date;
}

/** One reasoned correction, already assigned to its scope rung. */
export interface StructureCorrection {
  proposalId: string;
  userId: string;
  workspaceId: string | null;
  scopeKind: StructureGuidelineScopeKind;
  scopeRef: string | null;
  /** Taxonomy code, or the lowercased free text (reason-bucket precedence). */
  bucket: string;
  /** The reviewer's own words, when given. */
  reasonText: string | null;
  at: Date;
}

/** MIRROR of `proposalReasonBucket` (api reason-bucket.ts). */
export function reasonBucket(
  reasonCode: string | null | undefined,
  reason: string | null | undefined
): string | undefined {
  if (reasonCode && KNOWN_REASON_CODES.has(reasonCode)) return reasonCode;
  const freeText = reason?.trim().toLowerCase();
  return freeText || undefined;
}

interface EntityOpLike {
  op?: string;
  ref?: string;
  profileSlug?: string;
}

function operationsOf(data: unknown): EntityOpLike[] {
  const ops = (data as { operations?: unknown } | null)?.operations;
  return Array.isArray(ops) ? (ops as EntityOpLike[]) : [];
}

/**
 * The profile slug of the entity item a disposition key names: `$opN` is the
 * Nth `create_entity` op (types `opRef`), anything else an op's own `ref`.
 * A relation item (`$relN`) or an unresolvable key yields undefined.
 */
export function entityKindForItem(
  data: unknown,
  itemRef: string
): string | undefined {
  const entityOps = operationsOf(data).filter((o) => o?.op === "create_entity");
  const positional = /^\$op(\d+)$/.exec(itemRef);
  const op = positional
    ? entityOps[Number(positional[1])]
    : entityOps.find((o) => o.ref === itemRef);
  const slug = op?.profileSlug?.trim();
  return slug || undefined;
}

/** The proposal-level rung: an import's source kind, else the default rung. */
function proposalLevelScope(row: ExtractionProposalRow): {
  scopeKind: StructureGuidelineScopeKind;
  scopeRef: string | null;
} {
  if (row.proposalType === "import.graph") {
    const source = (row.data as { source?: unknown } | null)?.source;
    if (
      typeof source === "string" &&
      (IMPORT_SOURCE_VALUES as readonly string[]).includes(source)
    ) {
      return { scopeKind: "sourceKind", scopeRef: `import:${source}` };
    }
  }
  return { scopeKind: "default", scopeRef: null };
}

/**
 * Every reasoned correction a decided extraction proposal carries — a
 * whole-proposal reject (row columns) and every rejected item disposition.
 */
export function correctionsFromProposal(
  row: ExtractionProposalRow
): StructureCorrection[] {
  if (!row.userId) return [];
  const out: StructureCorrection[] = [];
  const push = (
    scope: { scopeKind: StructureGuidelineScopeKind; scopeRef: string | null },
    code: string | null | undefined,
    text: string | null | undefined
  ) => {
    const bucket = reasonBucket(code, text);
    if (!bucket || EXCLUDED_REASONS.has(bucket)) return;
    out.push({
      proposalId: row.id,
      userId: row.userId!,
      workspaceId: row.workspaceId,
      ...scope,
      bucket,
      reasonText: text?.trim() || null,
      at: row.decidedAt,
    });
  };

  if (row.status === ProposalStatus.REJECTED) {
    push(proposalLevelScope(row), row.reasonCode, row.rejectionReason);
    return out;
  }

  const dispositions = (
    row.data as {
      dispositions?: Record<
        string,
        { status?: string; reasonCode?: string; reason?: string }
      >;
    } | null
  )?.dispositions;
  if (!dispositions || typeof dispositions !== "object") return out;
  for (const [itemRef, disp] of Object.entries(dispositions)) {
    if (disp?.status !== "reject") continue;
    const kind = entityKindForItem(row.data, itemRef);
    push(
      kind
        ? { scopeKind: "entityKind", scopeRef: kind }
        : proposalLevelScope(row),
      disp.reasonCode,
      disp.reason
    );
  }
  return out;
}

export interface StructureCorrectionCluster {
  key: string;
  userId: string;
  workspaceId: string | null;
  scopeKind: StructureGuidelineScopeKind;
  scopeRef: string | null;
  corrections: StructureCorrection[];
}

export function structureClusterKey(c: {
  userId: string;
  scopeKind: string;
  scopeRef: string | null;
}): string {
  return `${c.userId}\0${c.scopeKind}\0${c.scopeRef ?? ""}`;
}

/** Group corrections per (user, rung, ref). No threshold here — see `qualifies`. */
export function clusterCorrections(
  corrections: StructureCorrection[]
): StructureCorrectionCluster[] {
  const byKey = new Map<string, StructureCorrectionCluster>();
  for (const c of corrections) {
    const key = structureClusterKey(c);
    const existing = byKey.get(key);
    if (existing) {
      existing.corrections.push(c);
      // Spanning workspaces ⇒ pod-wide: a workspace-scoped guideline would
      // silently not apply to the captures in the other workspace.
      if (existing.workspaceId !== c.workspaceId) existing.workspaceId = null;
      continue;
    }
    byKey.set(key, {
      key,
      userId: c.userId,
      workspaceId: c.workspaceId,
      scopeKind: c.scopeKind,
      scopeRef: c.scopeRef,
      corrections: [c],
    });
  }
  return [...byKey.values()];
}

/** The ONE place the knobs are applied. */
export function qualifies(
  corrections: readonly StructureCorrection[]
): boolean {
  return (
    corrections.length >= MIN_CORRECTIONS &&
    new Set(corrections.map((c) => c.proposalId)).size >= MIN_PROPOSALS
  );
}

/** Per-reason instruction line. `{kind}` is the data type the rung names. */
const INSTRUCTION_BY_REASON: Record<string, string> = {
  wrong_kind_or_facet:
    "Check whether {kind} is really its own kind of thing; when it is a role of something that already exists, attach the role instead of creating a new entity.",
  wrong_link_type:
    "Only link {kind} with a relation type that truly applies; leave the link out when unsure.",
  bad_data:
    "Copy field values for {kind} literally from the source; do not infer or complete values that are not written there.",
  not_relevant:
    "Only extract {kind} when the source is clearly about one; skip passing mentions.",
  wrong_entity:
    "Make sure {kind} refers to the real thing the source is about, not a similar one.",
};

function scopeLabel(
  scopeKind: StructureGuidelineScopeKind,
  scopeRef: string | null
): string {
  if (scopeKind === "entityKind" && scopeRef) return `a ${scopeRef}`;
  if (scopeKind === "sourceKind" && scopeRef)
    return `an item from ${scopeRef.replace(/^import:/, "")}`;
  return "an item";
}

function capText(text: string): string {
  return text.length > GUIDELINE_TEXT_MAX
    ? text.slice(0, GUIDELINE_TEXT_MAX)
    : text;
}

/**
 * ONLY what the evidence adds — deterministic from the corrections (no AI
 * door). Kept apart from the full text so a later rebase appends it once.
 */
export function draftStructureGuidelineAddition(
  cluster: Pick<StructureCorrectionCluster, "scopeKind" | "scopeRef">,
  corrections: readonly StructureCorrection[]
): string {
  const kind = scopeLabel(cluster.scopeKind, cluster.scopeRef);
  const histogram = reasonHistogram(corrections);
  const lines: string[] = [];
  for (const [bucket] of Object.entries(histogram).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    const line = INSTRUCTION_BY_REASON[bucket];
    if (line) lines.push(line.replace("{kind}", kind));
  }
  const examples = exampleReasons(corrections);
  if (examples.length > 0) {
    lines.push(`Reviewers said: ${examples.map((e) => `"${e}"`).join("; ")}.`);
  }
  if (lines.length === 0) {
    lines.push(
      `Reviewers rejected ${corrections.length} extracted items of this type — describe here what to do differently.`
    );
  }
  return capText(lines.join(" "));
}

/**
 * The DRAFT version text — the current guideline followed by the addition (or
 * the addition alone). A draft on purpose: the reviewer edits it before
 * approving.
 */
export function draftStructureGuidelineText(
  addition: string,
  currentText: string | null
): string {
  return capText(
    currentText?.trim() ? `${currentText.trim()}\n\n${addition}` : addition
  );
}

function reasonHistogram(
  corrections: readonly StructureCorrection[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of corrections) out[c.bucket] = (out[c.bucket] ?? 0) + 1;
  return out;
}

function exampleReasons(corrections: readonly StructureCorrection[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of corrections) {
    const t = c.reasonText?.replace(/\s+/g, " ").slice(0, 160);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

// ── Orchestration (DB access injected, so the dedup logic is testable) ──────

export interface StructureGuidelineScanDeps {
  loadDecidedExtractionProposals(since: Date): Promise<ExtractionProposalRow[]>;
  /** The cluster's most recent structure-guideline proposal, any status. */
  latestProposalForCluster(
    clusterKey: string
  ): Promise<{ id: string; status: string; createdAt: Date } | null>;
  findCoveringGuideline(
    cluster: StructureCorrectionCluster
  ): Promise<CurrentGuideline | null>;
  fileProposal(data: StructureGuidelineProposalData): Promise<string>;
  now(): Date;
}

/** Runs one scan pass; returns the ids of every filed proposal. */
export async function runStructureGuidelineScan(
  deps: StructureGuidelineScanDeps
): Promise<string[]> {
  const since = new Date(
    deps.now().getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const rows = await deps.loadDecidedExtractionProposals(since);
  const clusters = clusterCorrections(rows.flatMap(correctionsFromProposal));
  const filed: string[] = [];

  for (const cluster of clusters) {
    if (!qualifies(cluster.corrections)) continue;
    try {
      const latest = await deps.latestProposalForCluster(cluster.key);
      if (latest?.status === ProposalStatus.PENDING) continue;
      const covering = await deps.findCoveringGuideline(cluster);
      // NEW evidence only: decided after the last time this cluster was
      // proposed, and after the guideline row the pod already applies.
      const floor = Math.max(
        latest?.createdAt.getTime() ?? 0,
        covering?.createdAt.getTime() ?? 0
      );
      const fresh = cluster.corrections.filter((c) => c.at.getTime() > floor);
      if (!qualifies(fresh)) continue;

      const addition = draftStructureGuidelineAddition(cluster, fresh);
      const data: StructureGuidelineProposalData = {
        userId: cluster.userId,
        sourceId: cluster.userId,
        clusterKey: cluster.key,
        scopeKind: cluster.scopeKind,
        scopeRef: cluster.scopeRef,
        workspaceId: cluster.workspaceId,
        text: draftStructureGuidelineText(addition, covering?.text ?? null),
        addition,
        supersedesGuidelineId: covering?.id ?? null,
        currentText: covering?.text ?? null,
        evidence: {
          corrections: fresh.length,
          proposals: new Set(fresh.map((c) => c.proposalId)).size,
          windowDays: WINDOW_DAYS,
          reasonHistogram: reasonHistogram(fresh),
          exampleReasons: exampleReasons(fresh),
          sampleProposalIds: [...new Set(fresh.map((c) => c.proposalId))].slice(
            0,
            10
          ),
        },
      };
      filed.push(await deps.fileProposal(data));
    } catch (err) {
      logger.error(
        { err, clusterKey: cluster.key },
        "structure-guideline-scanner: failed for cluster, skipping"
      );
    }
  }
  return filed;
}

// ── DB tier ──────────────────────────────────────────────────────────────────

const dbDeps: StructureGuidelineScanDeps = {
  now: () => new Date(),

  async loadDecidedExtractionProposals(since) {
    const rows = await db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        status: proposals.status,
        subjectUserId: proposals.subjectUserId,
        createdBy: proposals.createdBy,
        workspaceId: proposals.workspaceId,
        reasonCode: proposals.reasonCode,
        rejectionReason: proposals.rejectionReason,
        data: proposals.data,
        reviewedAt: proposals.reviewedAt,
        updatedAt: proposals.updatedAt,
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.proposalType, [...EXTRACTION_PROPOSAL_TYPES]),
          or(
            eq(proposals.status, ProposalStatus.REJECTED),
            // Only approved rows that carry a rejected item disposition.
            drizzleSql`coalesce(jsonb_path_exists(${proposals.data}, '$.dispositions.*.status ? (@ == "reject")'), false)`
          ),
          gte(proposals.updatedAt, since)
        )
      )
      .orderBy(desc(proposals.updatedAt))
      .limit(SCAN_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      proposalType: r.proposalType,
      status: r.status,
      // capture/import graph rows carry the HUMAN in createdBy (see the
      // capture receipt note); subjectUserId is the 0248 owner floor.
      userId: r.subjectUserId ?? r.createdBy ?? null,
      workspaceId: r.workspaceId ?? null,
      reasonCode: r.reasonCode ?? null,
      rejectionReason: r.rejectionReason ?? null,
      data: r.data,
      decidedAt: r.reviewedAt ?? r.updatedAt,
    }));
  },

  async latestProposalForCluster(clusterKey) {
    const [row] = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.proposalType, STRUCTURE_GUIDELINE_PROPOSAL_TYPE),
          drizzleSql`${proposals.data}->>'clusterKey' = ${clusterKey}`
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(1);
    return row ?? null;
  },

  findCoveringGuideline: (cluster) =>
    findCurrentGuideline({
      db,
      userId: cluster.userId,
      scopeKind: cluster.scopeKind,
      scopeRef: cluster.scopeRef,
      workspaceId: cluster.workspaceId,
    }),

  async fileProposal(data) {
    const { proposal } = await insertPendingProposal({
      workspaceId: data.workspaceId,
      targetType: "governance",
      targetId: data.userId,
      proposalType: STRUCTURE_GUIDELINE_PROPOSAL_TYPE,
      data: data as unknown as Record<string, unknown>,
      createdBy: data.userId,
      proposedByUserId: null,
      // OWNER FLOOR (0248): the human whose corrections these are decides.
      subjectUserId: data.userId,
    });

    void emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId: data.userId,
      data: {
        proposalStatus: "created",
        targetType: "governance",
        changeType: STRUCTURE_GUIDELINE_PROPOSAL_TYPE,
      },
    }).catch((err) => {
      logger.warn(
        { err, proposalId: proposal.id },
        "structure-guideline-scanner: emitSideEffects failed (non-fatal)"
      );
    });

    logger.info(
      {
        userId: data.userId,
        scopeKind: data.scopeKind,
        scopeRef: data.scopeRef,
        corrections: data.evidence.corrections,
        supersedes: data.supersedesGuidelineId,
      },
      "structure-guideline-scanner: filed structure_guideline proposal"
    );
    return proposal.id;
  },
};

/**
 * Cron / on-demand handler. Manual trigger:
 * `await boss.send("structure-guideline.scan", {})`
 */
export async function handleStructureGuidelineScan(): Promise<void> {
  logger.info("structure-guideline-scanner: starting scan");
  const filed = await runStructureGuidelineScan(dbDeps);
  logger.info(
    { proposalsFiled: filed.length },
    "structure-guideline-scanner: scan complete"
  );
}
