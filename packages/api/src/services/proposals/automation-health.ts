/**
 * The automation-health WARDEN — DB tier + reporting.
 *
 * Pairs with `automation-health-predicate.ts`, which holds every decidable rule
 * (and the full rationale for why finding #1 is "zero-run" and not a
 * status-reading sibling). This file only fetches, guards against re-nagging,
 * and files.
 *
 * ── SHAPE: THE FOURTH RECOMMENDER, NOT A NEW WORKER ─────────────────────────
 * Deliberately built as a sibling of `recommend-tighten.ts` /
 * `recommend-tighten-posture.ts` / `recommend-raise-ceiling.ts`: a pure service
 * module invoked through a READ-ONLY builtin verb that auto-runs inside the
 * daily calibration cron automation.
 *
 * That choice IS the queue-registration answer. A pg-boss worker would have
 * needed a name in `ALL_QUEUES` — and the defect this project already paid for
 * (`governance.lane-scan` written, worked and scheduled but absent from
 * `ALL_QUEUES`, so pg-boss's FK threw and `scheduleSafe` swallowed it, and the
 * scanner never ran on any pod) lives exactly there. A builtin verb touches no
 * queue at all, so that failure mode is not merely avoided but unreachable.
 *
 * ── REPORTING: ONE GROUPED PROPOSAL PER OWNER ───────────────────────────────
 * NOT one proposal per automation. The measured review queue collapses 304
 * pending rows into 9 distinct fingerprints, and per-object review items are
 * how a queue teaches its reader to ignore it. So the scan files at most ONE
 * `automation.health_advisory` per OWNING HUMAN, carrying every one of that
 * human's findings as items keyed by `zeroRunItemRef(automationId)` — the same
 * ref `proposals.rejectItem` writes per-item dispositions under, so a reviewer
 * can dismiss individual findings through the door that already exists.
 *
 * Grouping BY OWNER is also the access containment: no finding about one
 * person's automation ever lands in a proposal filed for another. The scan
 * itself is pod-wide (pod-admin gated at the verb, exactly like its three
 * siblings), but the OUTPUT is partitioned by `automations.created_by` and
 * stamped `subjectUserId: owner` (the 0248 owner floor). Nothing here widens a
 * visibility floor.
 *
 * ── APPROVAL IS ACKNOWLEDGEMENT-ONLY ────────────────────────────────────────
 * Approving this proposal writes NOTHING — see the `automation.health_advisory`
 * branch in `routers/proposals/apply-approval.ts`, modelled byte-for-byte on
 * `governance.advisory`. It does NOT pause or archive the automations, and that
 * is the point: "never fired" almost always means NOTHING PRODUCES ITS TRIGGER,
 * and pausing the listener is the wrong remedy for a missing producer — the
 * same reasoning that makes `recommend-tighten` refuse to file a policy rule
 * for a mechanical fault. The warden proposes; the human disposes.
 *
 * That has a consequence this module must handle rather than ignore: since
 * approval changes no automation, a naive "is there a pending proposal?" guard
 * would let the warden re-file the same finding forever, one scan after every
 * decision. Hence {@link RENAG_COOLDOWN_DAYS} — the guard suppresses an
 * automation that carries an OPEN finding *or* one DECIDED inside the cooldown.
 */

import {
  db,
  and,
  eq,
  or,
  gte,
  lt,
  inArray,
  count,
  automations,
  automationRuns,
  proposals,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { notifyProposalCreatedOrdered } from "../../notifications/notify-proposal-created-ordered.js";
import {
  detectZeroRunAutomations,
  DEFAULT_MIN_AGE_DAYS,
  FIRING_STATUSES,
  PRODUCER_BACKED_TRIGGERS,
  type AutomationHealthRow,
  type ZeroRunFinding,
} from "./automation-health-predicate.js";

const logger = createLogger({ module: "automation-health-warden" });

/**
 * `automation.health_advisory` — the proposal type this warden files.
 *
 * Registered in `DIRECT_PROPOSAL_DOORS` (packages/governance-policy) as
 * `governance/automation.health_advisory`. That registration is NOT optional
 * bookkeeping: the cross-door parity tripwire source-scans for literal
 * `targetType`/`proposalType` pairs and fails any pair missing from the door
 * maps.
 */
export const AUTOMATION_HEALTH_ADVISORY_TYPE = "automation.health_advisory";

/** Bounds one scan's candidate set. Mirrors SCAN_LIMIT in recommend-tighten. */
const SCAN_LIMIT = 1000;

/**
 * How long a DECIDED finding suppresses a re-file for the same automation.
 *
 * Load-bearing because approval is a no-op (see the header): without it the
 * warden re-proposes every automation the human just looked at, on the next
 * scan, forever. 30 days is long enough that acting on a finding (wiring the
 * producer, or archiving the automation) removes it from the candidate set
 * before the cooldown lapses, and short enough that a finding the human left
 * unfixed resurfaces roughly monthly rather than never.
 */
export const RENAG_COOLDOWN_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The stored payload of an `automation.health_advisory` proposal. */
export interface AutomationHealthAdvisoryData {
  /** The human whose automations these are — also `subjectUserId` on the row. */
  ownerUserId: string;
  /** Which warden finding this is. One value today; the discriminant for the
   *  siblings the brief deliberately deferred (silent failure / silent no-op),
   *  so a future finding cannot be mistaken for this one by any reader. */
  findingKind: "zero_run";
  /** Every zero-run finding for this owner, keyed by `ref` for dispositions. */
  findings: ZeroRunFinding[];
  /** The scan parameters, so a stored finding is reproducible after a retune. */
  criteria: {
    minAgeDays: number;
    firingStatuses: readonly string[];
    producerBackedTriggers: readonly string[];
  };
  /** ISO scan instant. */
  scannedAt: string;
}

/**
 * Candidate automations: enabled, producer-backed trigger, old enough.
 *
 * The status / trigger / age filters are pushed into SQL as an OPTIMIZATION
 * only — {@link detectZeroRunAutomations} re-checks every one of them, so the
 * predicate's tests prove the real rule and a drift between this WHERE clause
 * and the predicate can only ever make the scan read MORE rows, never let an
 * unqualified row through.
 */
async function loadCandidateAutomations(
  cutoff: Date
): Promise<AutomationHealthRow[]> {
  return db
    .select({
      id: automations.id,
      name: automations.name,
      status: automations.status,
      triggerType: automations.triggerType,
      workspaceId: automations.workspaceId,
      createdBy: automations.createdBy,
      createdAt: automations.createdAt,
    })
    .from(automations)
    .where(
      and(
        // NO CAST. Both constants are `as const` literal tuples, so drizzle's
        // column enums type-check them directly — the compiler itself now
        // refuses a status or trigger the real column cannot hold, which is a
        // second, static half of the parity the `.status-parity` test pins.
        inArray(automations.status, FIRING_STATUSES),
        inArray(automations.triggerType, PRODUCER_BACKED_TRIGGERS),
        lt(automations.createdAt, cutoff)
      )
    )
    .limit(SCAN_LIMIT) as unknown as Promise<AutomationHealthRow[]>;
}

/**
 * automationId → total rows in the `automation_runs` LEDGER, ANY status.
 *
 * THE LEDGER, NOT THE COUNTER. `automations.run_count` exists and would be one
 * cheap column read — and it is a denormalized counter maintained by the
 * executor, i.e. exactly the kind of reported number this warden refuses to
 * build on. If the executor ever fails to increment it (or increments it for a
 * run it never recorded), the counter and reality diverge and the warden either
 * misses a dead automation or fabricates one. The ledger is the effect.
 *
 * Grouped COUNT rather than a row scan so a hot automation contributes one row.
 * Any status counts: `completed`, `failed`, `skipped`, `blocked_by_policy` and
 * a still-`running` row all prove the wire is live. This function must never
 * filter on status — that is the property the whole finding rests on.
 */
async function loadRunCounts(
  automationIds: string[]
): Promise<Map<string, number>> {
  if (automationIds.length === 0) return new Map();
  const rows = (await db
    .select({
      automationId: automationRuns.automationId,
      runs: count(),
    })
    .from(automationRuns)
    .where(inArray(automationRuns.automationId, automationIds))
    .groupBy(automationRuns.automationId)) as unknown as {
    automationId: string;
    runs: number;
  }[];
  return new Map(rows.map((r) => [r.automationId, Number(r.runs)]));
}

/**
 * THE RE-NAG GUARD. Every automation that already carries a health finding the
 * warden must not repeat this scan.
 *
 * Suppressed when EITHER:
 *   - an OPEN (pending) advisory already names it — never two live findings for
 *     one automation; or
 *   - a DECIDED advisory named it inside {@link RENAG_COOLDOWN_DAYS}. This half
 *     is what a pending-only guard would miss, and it is not hypothetical:
 *     approval writes nothing, so without it the very next scan re-files every
 *     finding the human just decided.
 *
 * Reads the ids out of the stored `findings[]` payload — the same array the
 * proposal displays — so the guard and the review item can never disagree about
 * which automations a finding covered.
 */
async function loadSuppressedAutomationIds(now: Date): Promise<Set<string>> {
  const cooldownStart = new Date(
    now.getTime() - RENAG_COOLDOWN_DAYS * MS_PER_DAY
  );
  const rows = await db
    .select({
      data: proposals.data,
      status: proposals.status,
      reviewedAt: proposals.reviewedAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, AUTOMATION_HEALTH_ADVISORY_TYPE),
        or(
          // Open: suppress regardless of age.
          eq(proposals.status, ProposalStatus.PENDING),
          // Decided: suppress only inside the cooldown. `reviewedAt` is NULL on
          // rows that left PENDING without a human review (expired/withdrawn),
          // and SQL `NULL >= x` is NULL — never true — so those rows fall out
          // of this arm on their own. That is the correct outcome: an expiry is
          // not a decision, so it must not buy a 30-day silence.
          gte(proposals.reviewedAt, cooldownStart)
        )
      )
    );

  // RE-CHECK IN JS, not only in SQL. The WHERE clause above is an optimization
  // that bounds the read; this loop is the RULE. Both halves matter and only
  // this one is provable without Postgres — a WHERE arm is invisible to any
  // mocked query, so a guard living only in SQL is a guard whose deletion no
  // test can notice. (Verified by mutation: removing the SQL cooldown arm left
  // every test green; removing this loop's check does not.) Same shape as the
  // candidate-filter re-check in `detectZeroRunAutomations`.
  const suppressed = new Set<string>();
  for (const row of rows) {
    const isOpen = row.status === ProposalStatus.PENDING;
    const decidedInCooldown =
      !isOpen &&
      row.reviewedAt instanceof Date &&
      row.reviewedAt.getTime() >= cooldownStart.getTime();
    // Anything else — decided before the cooldown, or a row that left PENDING
    // with no human review at all (expired/withdrawn leave `reviewedAt` NULL) —
    // buys no silence. An expiry is not a decision.
    if (!isOpen && !decidedInCooldown) continue;

    const data = row.data as Partial<AutomationHealthAdvisoryData> | null;
    if (!data?.findings) continue;
    for (const f of data.findings) {
      if (f?.automationId) suppressed.add(f.automationId);
    }
  }
  return suppressed;
}

/**
 * Run the warden. Returns the ids of every filed advisory.
 *
 * Resilient per OWNER — one owner's insert failing never aborts the batch
 * (mirrors `recommendTightenForAllAgents`).
 */
export async function scanAutomationHealth(opts?: {
  now?: Date;
  minAgeDays?: number;
}): Promise<{
  proposalsFiled: number;
  proposalIds: string[];
  findings: number;
}> {
  const now = opts?.now ?? new Date();
  const minAgeDays = opts?.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  logger.info({ minAgeDays }, "automation-health: starting zero-run scan");

  const cutoff = new Date(now.getTime() - minAgeDays * MS_PER_DAY);
  const candidates = await loadCandidateAutomations(cutoff);
  if (candidates.length === 0) {
    logger.info("automation-health: no candidate automations");
    return { proposalsFiled: 0, proposalIds: [], findings: 0 };
  }

  const runCountsByAutomationId = await loadRunCounts(
    candidates.map((c) => c.id)
  );
  const suppressedAutomationIds = await loadSuppressedAutomationIds(now);

  const findings = detectZeroRunAutomations({
    automations: candidates,
    runCountsByAutomationId,
    now,
    minAgeDays,
    suppressedAutomationIds,
  });
  if (findings.length === 0) {
    logger.info(
      {
        candidates: candidates.length,
        suppressed: suppressedAutomationIds.size,
      },
      "automation-health: no zero-run findings"
    );
    return { proposalsFiled: 0, proposalIds: [], findings: 0 };
  }

  // GROUP BY OWNER — one review item per human, never per automation.
  const byOwner = new Map<string, ZeroRunFinding[]>();
  for (const f of findings) {
    const list = byOwner.get(f.createdBy) ?? [];
    list.push(f);
    byOwner.set(f.createdBy, list);
  }

  const proposalIds: string[] = [];
  let failed = 0;

  for (const [ownerUserId, ownerFindings] of byOwner) {
    try {
      const data: AutomationHealthAdvisoryData = {
        ownerUserId,
        findingKind: "zero_run",
        findings: ownerFindings,
        criteria: {
          minAgeDays,
          firingStatuses: FIRING_STATUSES,
          producerBackedTriggers: PRODUCER_BACKED_TRIGGERS,
        },
        scannedAt: now.toISOString(),
      };

      const { proposal, deduped } = await insertPendingProposal({
        // Pod-wide: the findings can span several of the owner's workspaces, so
        // pinning the row to one would hide the rest behind a workspace lens.
        workspaceId: null,
        targetType: "governance",
        targetId: ownerUserId,
        proposalType: AUTOMATION_HEALTH_ADVISORY_TYPE,
        data: data as unknown as Record<string, unknown>,
        createdBy: ownerUserId,
        proposedByUserId: null,
        // OWNER FLOOR (0248): the human who owns these automations reviews them.
        subjectUserId: ownerUserId,
      });

      // TELL A HUMAN. `insertPendingProposal` fires NO notification of its own —
      // the same gap that once made every tighten proposal invisible. A deduped
      // hit already notified when it was first filed.
      //
      // ── NO LEAK, BUT A KNOWN ATTENTION GAP ──────────────────────────────
      // `notifyPodWideProposal` fans out to exactly `resolvePodAdminUserIds()`
      // — pod owner + pod admins. That is not a widening: this scan is already
      // `assertPodAdmin`-gated, so every recipient could have run the warden
      // and seen these automations anyway. The recipient set is a strict subset
      // of who could already see the data, and because findings are partitioned
      // by owner, no proposal's PAYLOAD ever mixes one person's automations
      // into another's.
      //
      // The gap is the mirror image: an owner who is NOT a pod admin gets the
      // proposal in their review inbox (the 0248 `subjectUserId` floor makes it
      // visible and reviewable by them) but gets NO BELL, because the shared
      // fan-out has no seam for "also tell the subject". Closing it means
      // changing `notify-pod-wide-proposal.ts`, which every other pod-wide
      // proposal author shares — deliberately NOT done here as a side effect of
      // adding a warden. Recorded rather than papered over: today the warden's
      // findings reliably reach admins, and reach a non-admin owner only when
      // they open the review queue.
      // ORDERED — fan-out first, emit second. See `notifyProposalCreatedOrdered`.
      await notifyProposalCreatedOrdered({
        podWide: deduped
          ? null
          : {
              proposalId: proposal.id,
              proposalType: AUTOMATION_HEALTH_ADVISORY_TYPE,
              description:
                ownerFindings.length === 1
                  ? `"${ownerFindings[0]!.name}" is enabled but has never run (${ownerFindings[0]!.ageDays} days)`
                  : `${ownerFindings.length} enabled automations have never run`,
            },
        sideEffect: {
          subjectId: proposal.id,
          userId: ownerUserId,
          data: {
            proposalStatus: "created",
            targetType: "governance",
            changeType: AUTOMATION_HEALTH_ADVISORY_TYPE,
          },
        },
        onEmitError: (err) =>
          logger.warn(
            { err, proposalId: proposal.id },
            "automation-health: emitSideEffects failed (non-fatal)"
          ),
      });

      proposalIds.push(proposal.id);
      logger.info(
        {
          ownerUserId,
          findings: ownerFindings.length,
          proposalId: proposal.id,
          deduped,
        },
        "automation-health: filed zero-run advisory"
      );
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ownerUserId },
        "automation-health: failed for owner, skipping"
      );
    }
  }

  logger.info(
    {
      candidates: candidates.length,
      suppressed: suppressedAutomationIds.size,
      findings: findings.length,
      owners: byOwner.size,
      failed,
      proposalsFiled: proposalIds.length,
    },
    "automation-health: scan complete"
  );
  return {
    proposalsFiled: proposalIds.length,
    proposalIds,
    findings: findings.length,
  };
}
