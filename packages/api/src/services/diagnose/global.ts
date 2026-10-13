/**
 * GLOBAL diagnosis — whole-pod health, composed from existing reads.
 *
 * A no-arg `diagnose` runs a fixed checklist and returns a ranked health report.
 * The door only ORCHESTRATES + RANKS; every signal reuses a primitive that
 * already exists (the runs substrate, the pending-proposal reads,
 * `collapseProposalsToClusters`). All USER-floored — it aggregates across every
 * workspace the caller can see (the sovereign "whole brain"), narrowable with a
 * `workspaceId`.
 *
 * HONEST-EMPTY by construction: when nothing is wrong the summary SAYS so
 * ("no stuck runs, no backlog, N capabilities healthy") rather than returning a
 * bare empty object.
 */

import {
  db,
  and,
  eq,
  desc,
  drizzleSql,
  proposals,
  ProposalStatus,
  capabilities,
  links,
  skills,
  inArray,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  ownAgentUserFilter,
  authoredByUser,
} from "../agent-identity-service.js";
import { listRuns, listRunGroups } from "../runs/index.js";
import {
  DEFAULT_STUCK_THRESHOLD_HOURS,
  RECENT_FAILURE_WINDOW_DAYS,
  isRecentFailure,
} from "@synap-core/types/run-activity";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../proposals/fingerprint.js";
import { agentProposalCap } from "../../utils/permission-check.js";
import type {
  GlobalHealthReport,
  HealthSection,
  HealthStatus,
} from "./types.js";
import {
  IDLE_STALL_MINUTES,
  classifyStalls,
  type StallReport,
} from "./stall.js";
import {
  reviewQueueApproval,
  reviewQueueVerdict,
  APPROVAL_FATIGUE_RATE,
  MIN_CONFIDENT_REVIEW_SAMPLE,
  type ReviewQueueApproval,
} from "./review-queue.js";
import {
  gatherSchemaContractSignal,
  summarizeSchemaContract,
  type SchemaContractSignal,
} from "./schema-contract.js";
import {
  gatherSchemaHygieneSignal,
  summarizeSchemaHygiene,
  type SchemaHygieneSignal,
} from "./schema-hygiene.js";
import {
  readQualityByPromptVersionSignal,
  summarizeQualityByPromptVersion,
  type QualityByPromptVersionSignal,
} from "./prompt-version-quality.js";

const HOUR_MS = 60 * 60 * 1000;
const PENDING_SCAN_LIMIT = 1000;
/** An agent this close to the daily cap is worth flagging as "attention". */
const CAP_ATTENTION_FRACTION = 0.8;

// ── The raw signals the pure summarizer ranks ────────────────────────────────

/**
 * Capability posture, counted where the execution gate reads it. A verb runs
 * only when its backing skill is enabled — `skills.approved`, the row
 * `gateCapabilityExecution` loads (packages/capability-gate) and the one
 * `capabilities.setToolEnabled` / the `capability.enable` executor flip. The
 * container's own `capabilities.approved` is read by no execution path, so it
 * is not counted: counting it reported "N awaiting approval" for a flag whose
 * approval changed nothing, while the verbs that actually refuse went unsaid.
 */
export interface CapabilityVerbPosture {
  /** Installed capability containers visible to the caller. */
  installed: number;
  /** Their member verbs (skills), each counted once. */
  verbs: number;
  /** Member verbs not enabled — every run of one is refused until it is. */
  verbsAwaitingEnable: number;
  /** Containers holding at least one such verb. */
  capabilitiesAwaitingEnable: number;
}

/**
 * PURE: the posture from the three reads `diagnoseGlobal` makes. A member link
 * to a skill that no longer exists is ignored (nothing to enable); a skill in
 * two containers is one verb, and makes both containers "awaiting".
 */
export function capabilityVerbPosture(input: {
  containerIds: readonly string[];
  members: ReadonlyArray<{ capabilityId: string; skillId: string }>;
  skills: ReadonlyArray<{ id: string; approved: boolean }>;
}): CapabilityVerbPosture {
  const approvedById = new Map(input.skills.map((s) => [s.id, s.approved]));
  const verbs = new Set<string>();
  const awaiting = new Set<string>();
  const awaitingCaps = new Set<string>();
  for (const m of input.members) {
    const approved = approvedById.get(m.skillId);
    if (approved === undefined) continue;
    verbs.add(m.skillId);
    if (!approved) {
      awaiting.add(m.skillId);
      awaitingCaps.add(m.capabilityId);
    }
  }
  return {
    installed: input.containerIds.length,
    verbs: verbs.size,
    verbsAwaitingEnable: awaiting.size,
    capabilitiesAwaitingEnable: awaitingCaps.size,
  };
}

/** A container whose verbs are not all turned on, with the verbs that refuse. */
export interface CapabilityAwaitingEnable {
  id: string;
  name: string;
  verbs: Array<{ id: string; name: string }>;
}

/**
 * PURE: the per-container view of the same graph `capabilityVerbPosture`
 * counts — which containers are fully on, and which hold verbs that refuse.
 * A container with no live member verb has nothing to turn on and is "enabled".
 */
export function capabilityVerbListing(graph: CapabilityVerbGraph): {
  enabled: Array<{ id: string; name: string }>;
  awaitingEnable: CapabilityAwaitingEnable[];
} {
  const skillById = new Map(graph.skills.map((s) => [s.id, s]));
  const offByContainer = new Map<string, Map<string, string>>();
  for (const m of graph.members) {
    const skill = skillById.get(m.skillId);
    if (!skill || skill.approved) continue;
    const off = offByContainer.get(m.capabilityId) ?? new Map<string, string>();
    off.set(skill.id, skill.name);
    offByContainer.set(m.capabilityId, off);
  }
  const enabled: Array<{ id: string; name: string }> = [];
  const awaitingEnable: CapabilityAwaitingEnable[] = [];
  for (const c of graph.containers) {
    const off = offByContainer.get(c.id);
    if (!off) {
      enabled.push({ id: c.id, name: c.name });
      continue;
    }
    awaitingEnable.push({
      id: c.id,
      name: c.name,
      verbs: [...off].map(([id, name]) => ({ id, name })),
    });
  }
  return { enabled, awaitingEnable };
}

export interface GlobalSignals {
  stuckHours: number;
  stuck: Array<{
    id: string;
    flowType: string;
    flowName: string;
    ageHours: number;
  }>;
  /**
   * The progress-based half of the stuck signal (see ./stall.ts). Optional so
   * existing callers/tests that only supply `stuck` keep working and simply get
   * the historical age-only verdict — absent means "not computed", and the
   * section says nothing about idleness rather than claiming none.
   */
  stall?: StallReport;
  /** Minutes of no-progress that counts as idle (echoed into thresholds). */
  idleMinutes?: number;
  failedFlows: Array<{
    flowName: string;
    failedCount: number;
    hasRunning: boolean;
    /**
     * The flow's own address, so a surface can make each failing flow a DOOR
     * to its page (the rail's health mark → Work › Activity › Failed). Absent
     * on the synthetic "Chat" row, which has no flow of its own.
     */
    flowType?: "automation" | "playbook";
    flowId?: string;
  }>;
  backlog: {
    pending: number;
    oldestAgeHours: number | null;
    /**
     * Pending rows traceable to this user whose `workspaceId` does NOT resolve
     * to a workspace they belong to — malformed/orphaned placement. Reported,
     * never dropped: a health door that hides broken records hides exactly the
     * ones needing attention.
     */
    mineOutsideLens: number;
    /**
     * Oldest pending row traceable to this user INCLUDING the ones the
     * workspace lens drops. `oldestAgeHours` above ranges only over the lensed
     * set, so on a pod with unresolvable placements it under-reports the true
     * age of the backlog.
     */
    oldestAgeHoursIncludingOutsideLens: number | null;
  };
  duplicateClusters: Array<{ targetLabel: string; count: number }>;
  capabilities: CapabilityVerbPosture;
  agentActivity: Array<{ agentId: string; pendingCount: number; cap: number }>;
  /**
   * How often the human APPROVES what the pod asks about — the decide queue's
   * own effectiveness. Optional for the same reason `stall` is: absent means
   * NOT COMPUTED, and the report then says nothing about the queue rather than
   * printing a fabricated 0%.
   */
  reviewQueue?: ReviewQueueApproval;
  /**
   * System-profile schema vs the seed (see ./schema-contract.ts). Optional for
   * the same reason: absent means NOT COMPUTED, and no section is emitted.
   */
  schemaContract?: SchemaContractSignal;
  /**
   * Pod hygiene (see ./schema-hygiene.ts). Optional: absent means NOT
   * COMPUTED, and no section is emitted.
   */
  schemaHygiene?: SchemaHygieneSignal;
  /**
   * Review outcomes per intake-run prompt version. Optional: absent means NOT
   * COMPUTED (no section); `available: false` means the read FAILED (a section
   * that says so).
   */
  qualityByPromptVersion?: QualityByPromptVersionSignal;
}

/**
 * PURE: rank the signals into sections + a roll-up status + an honest-empty
 * plain-language summary. DB-free, so this is the unit-tested heart of GLOBAL.
 */
export function summarizeGlobalHealth(
  signals: GlobalSignals,
  scope: { workspaceId: string | null }
): GlobalHealthReport {
  const sections: HealthSection[] = [];

  // Stuck runs — TWO signals, ranked (see ./stall.ts for why age alone lied).
  //   aged (past the hour boundary)      → degraded, the historical verdict
  //   idle (no progress, minutes-scale)  → attention, "worth a look"
  // `count` / `oldest` keep meaning EXACTLY what they meant (the aged list), so
  // the browser's FlowHealthBand and the Raycast card read unchanged; idleness
  // is additive detail. `unobservableRunning` is stated out loud: a section that
  // silently omits the runs it cannot judge is how "No stuck runs" got printed
  // over a hung session in the first place.
  const idle = signals.stall?.idle ?? [];
  const unobservable = signals.stall?.unobservable ?? 0;
  const idleMinutes = signals.idleMinutes ?? null;
  sections.push({
    key: "stuck_runs",
    status:
      signals.stuck.length > 0
        ? "degraded"
        : idle.length > 0
          ? "attention"
          : "ok",
    headline:
      signals.stuck.length > 0
        ? `${signals.stuck.length} run(s) still running past ${signals.stuckHours}h` +
          (idle.length > 0 ? `, ${idle.length} more idle` : "")
        : idle.length > 0
          ? `${idle.length} run(s) running but idle${
              idleMinutes !== null
                ? ` for over ${Math.round(idleMinutes)}m`
                : ""
            }`
          : "No stuck runs",
    detail: {
      count: signals.stuck.length,
      thresholdHours: signals.stuckHours,
      oldest: signals.stuck.slice(0, 5),
      idleCount: idle.length,
      idleThresholdMinutes: idleMinutes,
      idlest: idle.slice(0, 5),
      /** Running runs whose ledger records no progress timestamp at all. */
      unobservableRunning: unobservable,
    },
  });

  // Failing flows — degraded if any flow failed in the last 7 days (W2 calm).
  // `failedFlows` is already windowed at the source (`recentFailedCount`), so
  // the health number is DISTINCT FLOWS failing now — never lifetime runs, which
  // read "339 failing" for one flow that broke in June.
  const failedTotal = signals.failedFlows.reduce(
    (s, f) => s + f.failedCount,
    0
  );
  const failingFlows = signals.failedFlows.length;
  sections.push({
    key: "failed_flows",
    status: failingFlows > 0 ? "degraded" : "ok",
    headline:
      failingFlows > 0
        ? `${failingFlows} flow(s) failing in the last ${RECENT_FAILURE_WINDOW_DAYS} days`
        : `No flow failed in the last ${RECENT_FAILURE_WINDOW_DAYS} days`,
    detail: {
      flows: signals.failedFlows.slice(0, 10),
      /** THE health number: distinct flows with a failed run in the window. */
      failingFlows,
      /** Failed runs inside the window, summed over those flows. */
      failedTotal,
      windowDays: RECENT_FAILURE_WINDOW_DAYS,
    },
  });

  // Review backlog — attention when non-empty; degraded when it's gone stale.
  const oldest = signals.backlog.oldestAgeHours;
  const backlogStatus: HealthStatus =
    signals.backlog.pending === 0
      ? "ok"
      : oldest !== null && oldest > 48
        ? "degraded"
        : "attention";
  const mineOutsideLens = signals.backlog.mineOutsideLens;
  sections.push({
    key: "review_backlog",
    status: backlogStatus,
    headline:
      signals.backlog.pending === 0 && mineOutsideLens === 0
        ? "No pending proposals"
        : `${signals.backlog.pending} pending proposal(s)` +
          (oldest !== null ? `, oldest ${Math.round(oldest)}h` : "") +
          // Name the gap rather than dropping it. These rows are pending and
          // traceable to this user, but their workspaceId does not resolve to
          // a workspace they are a member of — malformed or orphaned placement.
          // Silently excluding them is what made this door disagree with
          // `orient` across three external test passes.
          (mineOutsideLens > 0
            ? `; ${mineOutsideLens} more of yours sit outside your workspace lens (unresolvable placement) — list proposals to see them`
            : ""),
    detail: { ...signals.backlog, mineOutsideLens },
  });

  // Similar-proposal groups — a review-GROUPING signal, not a duplicate
  // detector: `computeProposalFingerprint` clusters on a deliberately loose
  // structural key (proposalType × targetType × name), so a cluster can
  // legitimately contain distinct payloads that merely share that shape (see
  // the file's own FINGERPRINT_CAUSE_EXTENSION note). It reads "N proposals
  // want to change X" for the reviewer — it is NOT evidence of a governance
  // bug. The strict, preventive de-duplication is `dedup_hash` + the 0208
  // partial unique index, a separate mechanism this section does not surface.
  // `attention` here means "worth a look", never "degraded" — a grouping is
  // informational and must never register as a health failure.
  sections.push({
    key: "duplicate_proposals",
    status: signals.duplicateClusters.length > 0 ? "attention" : "ok",
    headline:
      signals.duplicateClusters.length > 0
        ? `${signals.duplicateClusters.length} proposal(s) grouped by similarity for review`
        : "No similar-proposal groups pending review",
    detail: { clusters: signals.duplicateClusters.slice(0, 10) },
  });

  // Capabilities — attention when installed verbs are not turned on: those
  // are the runs that refuse (see `CapabilityVerbPosture`). A verb runs only
  // when its backing skill is enabled (`skills.approved`); the container's own
  // `approved` flag gates nothing, so it is not counted. Live per-connection
  // outage detection is not part of this section.
  const cap = signals.capabilities;
  sections.push({
    key: "capabilities",
    status: cap.verbsAwaitingEnable > 0 ? "attention" : "ok",
    headline:
      cap.installed === 0
        ? "No capabilities installed"
        : cap.verbsAwaitingEnable > 0
          ? `${cap.verbsAwaitingEnable} verb(s) in ${cap.capabilitiesAwaitingEnable} capability(ies) not turned on — they refuse to run until turned on`
          : `${cap.installed} capability(ies) installed, all ${cap.verbs} verb(s) turned on`,
    detail: {
      ...cap,
      // Read by the desktop app's FlowHealthBand until it reads
      // `verbsAwaitingEnable`; drop it once that reader moves.
      unapproved: cap.capabilitiesAwaitingEnable,
    },
  });

  // Agent activity — degraded when an agent is at/over the daily cap.
  const overCap = signals.agentActivity.filter((a) => a.pendingCount >= a.cap);
  const nearCap = signals.agentActivity.filter(
    (a) =>
      a.pendingCount < a.cap && a.pendingCount >= a.cap * CAP_ATTENTION_FRACTION
  );
  sections.push({
    key: "agent_activity",
    status:
      overCap.length > 0 ? "degraded" : nearCap.length > 0 ? "attention" : "ok",
    headline:
      overCap.length > 0
        ? `${overCap.length} agent(s) hit the daily proposal cap`
        : nearCap.length > 0
          ? `${nearCap.length} agent(s) approaching the daily cap`
          : "No agent flooding the queue",
    detail: { overCap, nearCap },
  });

  // Review-queue approval rate — is the decide queue doing work, or is it
  // theatre? `attention` (never `degraded`) when a CREDIBLE sample approves
  // almost everything: that is a finding about the product, not a fault in the
  // pod, and a measurement must not masquerade as an outage. The headline
  // always carries the DENOMINATOR, because "93%" with no "of what" is the
  // lens-relative count this codebase has shipped unlabelled before.
  const rq = signals.reviewQueue;
  if (rq) {
    const verdict = reviewQueueVerdict(rq);
    const pct =
      rq.approveRateOfReviewed === null
        ? null
        : Math.round(rq.approveRateOfReviewed * 100);
    // `HealthStatus` has no neutral/"unknown" member (`"ok" | "attention" |
    // "degraded"`, `types.ts`) — widening it is a contract change every other
    // reader of this union would have to absorb. So `verdict === "unknown"`
    // (no reviewed proposals, or `lowSample`) is deliberately mapped to `"ok"`,
    // NOT `"attention"`: there is nothing here for the user to act on, and
    // `"attention"` in the rollup below would flag the whole pod for a queue
    // that simply hasn't been used yet — the false-alarm failure mode this
    // file already avoids for `agent_activity`. The headline still carries the
    // caveat ("no approval rate to report" / "sample under N"), so the
    // uncertainty is visible without being reported as a fault.
    sections.push({
      key: "review_queue",
      status: verdict === "approval_fatigue" ? "attention" : "ok",
      headline:
        rq.reviewed === 0
          ? "No proposal has been reviewed yet — no approval rate to report"
          : `You approved ${rq.approvedInFull} of ${rq.reviewed} reviewed proposal(s) in full (${pct}%)` +
            (rq.lowSample
              ? ` — sample under ${MIN_CONFIDENT_REVIEW_SAMPLE}, read the counts not the rate`
              : verdict === "approval_fatigue"
                ? `; over ${Math.round(APPROVAL_FATIGUE_RATE * 100)}% — the queue may be asking questions you always answer yes to`
                : "") +
            (rq.autoApprovedNeverReviewed > 0
              ? ` (${rq.autoApprovedNeverReviewed} more were auto-approved and never reached you — not counted)`
              : ""),
      detail: {
        ...rq,
        verdict,
        denominator:
          "reviewed = proposals YOU decided (approved in full + approved with items denied + rejected); excludes pending, withdrawn, expired and auto-approved",
        lens: "proposals visible in your workspaces or authored by you (proposalUserFloor)",
      },
    });
  }

  if (signals.schemaContract) {
    sections.push(summarizeSchemaContract(signals.schemaContract));
  }

  if (signals.schemaHygiene) {
    sections.push(
      summarizeSchemaHygiene(
        signals.schemaHygiene,
        signals.schemaContract?.twins
      )
    );
  }

  if (signals.qualityByPromptVersion) {
    sections.push(
      summarizeQualityByPromptVersion(signals.qualityByPromptVersion)
    );
  }

  // Roll up: worst section wins.
  const rank: Record<HealthStatus, number> = {
    ok: 0,
    attention: 1,
    degraded: 2,
  };
  const status = sections.reduce<HealthStatus>(
    (worst, s) => (rank[s.status] > rank[worst] ? s.status : worst),
    "ok"
  );

  const problems = sections.filter((s) => s.status !== "ok");
  const summary =
    problems.length === 0
      ? `All clear — no stuck runs, no failed flows, no review backlog, and every verb of ${signals.capabilities.installed} capability(ies) enabled.`
      : `${problems.length} area(s) need attention: ` +
        problems.map((s) => s.headline).join("; ") +
        ".";

  return {
    mode: "global",
    status,
    summary,
    thresholds: {
      stuckHours: signals.stuckHours,
      ...(idleMinutes !== null ? { idleMinutes } : {}),
    },
    scope,
    sections,
  };
}

/**
 * One run group → one failing-flow row: the WINDOWED failure count, plus the
 * flow's address (`flowType` + `flowId`) so a surface can open the flow's own
 * page. Pure and exported so the projection is tested at the seam — a dropped
 * address field would otherwise leave every failing flow a dead row while
 * every type still checks.
 */
export function failingFlowOfGroup(g: {
  flowName: string;
  recentFailedCount: number;
  hasRunning: boolean;
  flowType: "automation" | "playbook";
  flowId: string;
}): GlobalSignals["failedFlows"][number] {
  return {
    flowName: g.flowName,
    failedCount: g.recentFailedCount,
    hasRunning: g.hasRunning,
    flowType: g.flowType,
    flowId: g.flowId,
  };
}

// ── DB tier: gather the signals, then summarize ──────────────────────────────

/** The three hops behind the posture, with names for a per-container listing. */
export interface CapabilityVerbGraph {
  containers: Array<{ id: string; name: string }>;
  members: Array<{ capabilityId: string; skillId: string }>;
  skills: Array<{ id: string; name: string; approved: boolean }>;
}

/**
 * The containers the caller can see (same floor and lens as the rest of this
 * report), their `member_of` verbs, and those verbs' enable flags — the same
 * three hops `buildCapabilityCatalog` folds into a card's `verbs[].enabled`,
 * so this count and the Marketplace's Tools list cannot disagree. Shared with
 * the `type:"capability"` class arm so both surfaces count the same thing.
 */
export async function readCapabilityVerbGraph(
  userId: string,
  workspaceId: string | null
): Promise<CapabilityVerbGraph> {
  const containers = await db
    .select({ id: capabilities.id, name: capabilities.name })
    .from(capabilities)
    .where(
      and(
        userVisibleWhere(capabilities.workspaceId, userId),
        workspaceId ? eq(capabilities.workspaceId, workspaceId) : undefined
      )
    );
  const containerIds = containers.map((c) => c.id);
  const members =
    containerIds.length > 0
      ? await db
          .select({ capabilityId: links.toId, skillId: links.fromId })
          .from(links)
          .where(
            and(
              eq(links.toType, "capability"),
              inArray(links.toId, containerIds),
              eq(links.linkType, "member_of"),
              eq(links.fromType, "skill")
            )
          )
      : [];
  const skillIds = [...new Set(members.map((m) => m.skillId))];
  const skillRows =
    skillIds.length > 0
      ? await db
          .select({
            id: skills.id,
            name: skills.name,
            approved: skills.approved,
          })
          .from(skills)
          .where(inArray(skills.id, skillIds))
      : [];
  return { containers, members, skills: skillRows };
}

async function readCapabilityVerbPosture(
  userId: string,
  workspaceId: string | null
): Promise<CapabilityVerbPosture> {
  const graph = await readCapabilityVerbGraph(userId, workspaceId);
  return capabilityVerbPosture({
    containerIds: graph.containers.map((c) => c.id),
    members: graph.members,
    skills: graph.skills,
  });
}

/**
 * Run the whole-pod health checklist for `userId`. `workspaceId` narrows the
 * floor to one lens; `stuckThresholdHours` overrides the "stuck" boundary.
 */
export async function diagnoseGlobal(params: {
  userId: string;
  workspaceId?: string | null;
  stuckThresholdHours?: number;
}): Promise<GlobalHealthReport> {
  const { userId } = params;
  const workspaceId = params.workspaceId ?? null;
  const stuckHours =
    params.stuckThresholdHours ?? DEFAULT_STUCK_THRESHOLD_HOURS;
  const now = Date.now();
  const scope = workspaceId ? { workspaceId } : undefined;

  // Fire the independent reads together.
  // Chat is included in listRuns only for status=running|failed (or
  // flowType=chat) so successful Discord pings never flood stuck/failed.
  const [
    runningRuns,
    groups,
    failedChatRuns,
    backlogRow,
    // Author-floored twin of `backlogRow` — see the comment on its query.
    mineBacklogRow,
    pendingRows,
    capabilitiesSignal,
    agentRows,
  ] = await Promise.all([
    // Stuck: running runs across flows (per-flow cap 100), aged client-side.
    // Includes chat turns still `running` past the threshold.
    listRuns({ userId, status: "running", scope, limit: 100 }),
    // Failed: per-flow failure counts (automation/playbook — already in-DB).
    listRunGroups({ userId, scope, limit: 100 }),
    // Failed chat turns (no flowId group) — B4: only failures, not successes.
    listRuns({ userId, flowType: "chat", status: "failed", scope, limit: 100 }),
    // Backlog: exact count + oldest age of pending proposals (user-floored).
    db
      .select({
        pending: drizzleSql<number>`count(*)::int`,
        oldest: drizzleSql<Date | null>`min(${proposals.createdAt})`,
      })
      .from(proposals)
      .where(
        and(
          userVisibleWhere(proposals.workspaceId, userId),
          eq(proposals.status, ProposalStatus.PENDING),
          workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
        )
      ),
    // SECOND floor, deliberately: the count above is WORKSPACE-lensed, so a
    // pending row whose `workspaceId` does not resolve to a workspace this user
    // is a member of is DROPPED — and those are exactly the rows that need
    // attention (orphaned workspace ids; one row carries a USER id in the
    // workspace column). A health door that hides malformed records is the
    // worst place for that to happen: three external test passes reported
    // `diagnose` saying 11 while `orient` and `list_proposals` said 14.
    //
    // This adds NO disclosure. It is the same AUTHOR floor `orient` already
    // reports to this same user (`discover.ts`), so the number is one the
    // caller can already see — it just stops two surfaces disagreeing without
    // explanation. It is NOT a workspace widening: no membership term.
    db
      .select({
        mine: drizzleSql<number>`count(*)::int`,
        oldest: drizzleSql<Date | null>`min(${proposals.createdAt})`,
      })
      .from(proposals)
      .where(
        and(
          authoredByUser(userId),
          eq(proposals.status, ProposalStatus.PENDING),
          workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
        )
      ),
    // Duplicate clustering: a capped scan of the pending rows.
    db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
        createdAt: proposals.createdAt,
        workspaceId: proposals.workspaceId,
      })
      .from(proposals)
      .where(
        and(
          userVisibleWhere(proposals.workspaceId, userId),
          eq(proposals.status, ProposalStatus.PENDING),
          workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(PENDING_SCAN_LIMIT),
    // Capability posture: installed verbs enabled vs not (user-floored).
    readCapabilityVerbPosture(userId, workspaceId),
    // Agent activity: per-agent PENDING proposal counts for this owner — the
    // population the F2 cap protects (the review queue, not write volume).
    //
    // Floored by LINEAGE (`agentUserId` is one of MY agents), not by
    // `createdBy = <human> AND agentUserId IS NOT NULL`. That pair excluded
    // the MAJORITY row shape: `proposals.createdBy` is overloaded ("userId or
    // agentUserId that authored this row"), so an agent write that passes no
    // explicit createdBy lands `createdBy = agentUserId = <agent>` — measured
    // live at 4 of 6 pending on this pod. The cap (`countPendingAgentProposals`)
    // counts `agentUserId` alone, so the old pair here displayed a SMALLER
    // number than the counter enforcing the refusal this panel exists to
    // explain. Same floor as the cap = the two agree.
    db
      .select({
        agentId: proposals.agentUserId,
        pendingCount: drizzleSql<number>`count(*)::int`,
      })
      .from(proposals)
      .where(
        and(
          ownAgentUserFilter(proposals.agentUserId, userId),
          // SAME POPULATION AS THE ENFORCER. `countPendingAgentProposals`
          // (utils/permission-check.ts) counts ONLY still-PENDING proposals —
          // the review queue the budget protects. An approved / rejected /
          // auto-approved row never sits in that queue, so none of them may be
          // counted here; counting anything wider made the display announce a
          // cap hit the enforcer was never enforcing. This is the FOURTH time
          // in this area that two queries answering one question diverged
          // (broken createdBy pair; hardcoded base cap; counter vs gate
          // population; now display vs enforcer). Pinned by
          // `__tripwires__/diagnose-surface-parity.test.ts`.
          eq(proposals.status, ProposalStatus.PENDING)
        )
      )
      .groupBy(proposals.agentUserId),
  ]);

  // ONE pass over the running set produces BOTH halves of the signal — the aged
  // list (unchanged shape, unchanged meaning) and the progress-based idle list.
  const stall = classifyStalls(
    runningRuns.map((r) => ({
      id: r.id,
      flowType: r.flowType,
      flowName: r.flowName,
      startedAt: r.startedAt,
      lastActivityAt: r.lastActivityAt,
    })),
    now,
    { agedHours: stuckHours, idleMinutes: IDLE_STALL_MINUTES }
  );
  const stuck = stall.aged.map((r) => ({
    id: r.id,
    flowType: r.flowType,
    flowName: r.flowName,
    ageHours: r.ageHours,
  }));

  // Windowed at the source (W2 calm): a flow is failing iff it failed in the
  // last RECENT_FAILURE_WINDOW_DAYS; `failedCount` here is that window's count.
  const failedFlows: GlobalSignals["failedFlows"] = groups
    .filter((g) => g.recentFailedCount > 0)
    .map(failingFlowOfGroup);
  // Chat has no flowId group — surface failed chat as one synthetic "Chat" row,
  // windowed the same way.
  // The SAME cutoff rule the flow groupers apply in SQL (`isRecentFailure`).
  const recentFailedChat = failedChatRuns.filter((r) =>
    isRecentFailure(r, now)
  );
  if (recentFailedChat.length > 0) {
    failedFlows.push({
      flowName: "Chat",
      failedCount: recentFailedChat.length,
      hasRunning: runningRuns.some((r) => r.flowType === "chat"),
    });
  }

  const backlogPending = backlogRow[0]?.pending ?? 0;
  const backlog = {
    pending: backlogPending,
    oldestAgeHours: backlogRow[0]?.oldest
      ? (now - new Date(backlogRow[0].oldest).getTime()) / HOUR_MS
      : null,
    // Clamped at 0: the author floor is NOT a superset of the workspace floor
    // (a teammate's row in a shared workspace is workspace-visible but not
    // author-mine), so the difference can legitimately go negative and a
    // negative "hidden" count would be nonsense.
    mineOutsideLens: Math.max(
      0,
      (mineBacklogRow[0]?.mine ?? 0) - backlogPending
    ),
    // The AGE must range over the same population the headline claims, or the
    // reconciliation is half-done: the count said 15 while "oldest" still
    // reported 2026-07-21 — the workspace-lensed minimum — when the true
    // oldest row this user owns is 2026-06-27, one of the four the lens drops.
    // Reporting a hidden row's existence but not its age is the same defect
    // one field over.
    oldestAgeHoursIncludingOutsideLens: mineBacklogRow[0]?.oldest
      ? (now - new Date(mineBacklogRow[0].oldest).getTime()) / HOUR_MS
      : null,
  };

  const clusterRows: ClusterInputRow[] = pendingRows.map((r) => ({
    id: r.id,
    proposalType: r.proposalType,
    targetType: r.targetType,
    targetId: r.targetId,
    data: r.data,
    createdAt: r.createdAt,
    workspaceId: r.workspaceId ?? null,
  }));
  const duplicateClusters = collapseProposalsToClusters(clusterRows)
    .filter((c) => c.count > 1)
    .map((c) => ({ targetLabel: c.targetLabel, count: c.count }))
    .sort((a, b) => b.count - a.count);

  const agentActivityCounts = agentRows
    .filter((a): a is { agentId: string; pendingCount: number } =>
      Boolean(a.agentId)
    )
    .map((a) => ({ agentId: a.agentId, pendingCount: a.pendingCount }));

  // Resolve the REAL cap per agent, not the base constant.
  //
  // `agentProposalCap` applies the trust multiplier (a proven agent —
  // >=100 recent proposals at >=95% approve rate — earns 3x). Hardcoding
  // `AGENT_PENDING_PROPOSAL_CAP` here made this door announce
  // "1 agent(s) hit the daily proposal cap" for an agent sitting at 13/30,
  // while `diagnose(agentId)` correctly reported `cap: 30, atOrOverCap: false`
  // from the same numbers. A health door raising a FALSE alarm is worse than
  // the silent drop this section previously had: it sends the user to
  // investigate a block that is not happening. One resolver, both surfaces.
  // The queue's own effectiveness. Its own read (two small aggregates) rather
  // than a term in the big Promise.all above: it is floored by
  // `proposalUserFloor`, the queue's OWN builder, not by the bare workspace
  // lens the backlog counts use — mixing the two floors into one query is how
  // this file's counts disagreed with `orient` before. Still independent of
  // `agentActivity` (which depends on `agentRows` from the big Promise.all),
  // so the two awaits run concurrently rather than round-tripping serially.
  const [
    agentActivity,
    reviewQueue,
    schemaContract,
    qualityByPromptVersion,
    schemaHygiene,
  ] = await Promise.all([
    Promise.all(
      agentActivityCounts.map(async (a) => ({
        ...a,
        cap: await agentProposalCap(a.agentId),
      }))
    ),
    reviewQueueApproval({ userId, workspaceId }),
    gatherSchemaContractSignal({ userId, workspaceId }),
    readQualityByPromptVersionSignal({ userId, workspaceId }),
    gatherSchemaHygieneSignal({ userId, workspaceId }),
  ]);

  return summarizeGlobalHealth(
    {
      stuckHours,
      stuck,
      stall,
      idleMinutes: IDLE_STALL_MINUTES,
      failedFlows,
      backlog,
      duplicateClusters,
      capabilities: capabilitiesSignal,
      agentActivity,
      reviewQueue,
      schemaContract,
      schemaHygiene,
      qualityByPromptVersion,
    },
    { workspaceId }
  );
}
