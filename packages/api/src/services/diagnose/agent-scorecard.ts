/**
 * Agent-quality scorecard — the ALWAYS-ON, agent-system-AGNOSTIC tier.
 *
 * Pure SQL over `proposals` keyed by `proposals.agentUserId`, over the last 7
 * days (`scorecardWindow`): approve/reject/revise rates, a rejection-reason
 * histogram, and a duplicate rate derived from the SAME structural fingerprint
 * the review inbox uses (read from a bounded sample, which the card names). It describes an agent's
 * *behaviour* from governance data the pod already owns — never its
 * implementation, so there is NO `switch(agentType)` and NO Intelligence-Service
 * coupling (root CLAUDE.md: `agentType ⟂ intelligenceServiceId`).
 *
 * The optional "deep quality" tier (prompt/trace quality) is an IS-provided
 * capability verb resolved through the normal capability ladder — deliberately
 * NOT built here; this pod-side card is the floor that works for any agent.
 */

import {
  db,
  and,
  eq,
  gte,
  or,
  desc,
  drizzleSql,
  isNotNull,
  inArray,
  proposals,
  users,
  ProposalStatus,
  notAnAppAgent,
} from "@synap/database";
import type { ProposalRevision } from "@synap/database";
import {
  isHumanRevision,
  isPartiallyApprovedData,
} from "@synap-core/types/proposals";
import { proposalReasonBucket } from "../proposals/reason-bucket.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { authoredByUser } from "../agent-identity-service.js";
import { isPodAdmin } from "../../utils/workspace-role.js";
import { collapseProposalsToClusters } from "../proposals/fingerprint.js";
import type { ClusterInputRow } from "../proposals/fingerprint.js";
import {
  AGENT_PENDING_PROPOSAL_CAP,
  agentProposalCap,
  countPendingAgentProposals,
} from "../../utils/permission-check.js";
import type { AgentScorecard } from "./types.js";

/** The minimum a proposal row must expose to score an agent. Fingerprint-shaped. */
export interface ScorecardProposalRow {
  proposalType: string;
  targetType: string;
  targetId: string;
  /**
   * The stored `proposals.data`. Feeds the duplicate fingerprint AND —
   * via `isPartiallyApprovedData` — the partial-approval split below, so a
   * gutted package is never scored as a full endorsement. Deliberately NOT a
   * pre-computed reject-count field: `data` is already on the row, and a second
   * representation of the same fact is a fork waiting to disagree with it.
   */
  data: unknown;
  status: string;
  rejectionReason: string | null;
  reasonCode: string | null;
  revisionHistory: ProposalRevision[] | null;
  createdAt: Date;
  workspaceId: string | null;
}

/**
 * A revision is a HUMAN CORRECTION only when no agent made it — THE one rule,
 * in `@synap-core/types/proposals` (the trust ladder's earned streak reads it
 * too). Re-exported for this module's importers.
 */
export { isHumanRevision };

/** The window the per-agent card counts over (`AgentScorecard.window`). */
export interface ScorecardWindow {
  from: string;
  to: string;
  days: number;
}

/**
 * The card's window ending at `now`: the last {@link RECENT_WRITES_WINDOW_DAYS}
 * days, the same 7 days the Agents page counts its "writes · 7d" over, so the
 * two numbers on that page describe one period.
 */
export function scorecardWindow(now: Date): ScorecardWindow {
  const days = RECENT_WRITES_WINDOW_DAYS;
  return {
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
    days,
  };
}

/**
 * How many of the window's newest proposals the duplicate rate clusters.
 * The ONLY bounded number on the card: clustering needs each payload, so it
 * reads a sample and says so (`AgentScorecard.duplicateSample`). Every count
 * and the other rates are SQL counts over the whole window — a cap on THOSE
 * is what hid a day's rejections from a card that saw only the newest 500 (a
 * busy agent files 500 proposals in about 3 hours).
 */
export const DUPLICATE_SAMPLE_LIMIT = 500;

/** One fingerprint-shaped row of the duplicate sample. */
export type ScorecardSampleRow = Omit<ClusterInputRow, "id">;

/**
 * What the card is folded from. The DB tier fills it with SQL aggregates over
 * the window; {@link scorecardAggregatesFromRows} fills it from raw rows (the
 * pure tests). Either way the RULES — partial apply, human revision, reason
 * bucket, duplicate fingerprint — are applied once, in {@link foldAgentScorecard}.
 */
export interface ScorecardAggregates {
  /** `count(*)` per status over the window — every proposal, never capped. */
  statusCounts: ReadonlyArray<{ status: string; count: number }>;
  /**
   * `data` of each APPLIED (approved / auto-approved) proposal that may be a
   * partial apply. A superset is fine (the DB tier sends every applied row
   * carrying a `dispositions` key): `isPartiallyApprovedData` decides.
   */
  appliedData: ReadonlyArray<unknown>;
  /**
   * `revisionHistory` of each proposal that has one. A superset is fine:
   * `isHumanRevision` decides.
   */
  revisionHistories: ReadonlyArray<unknown>;
  /** `count(*)` per (reasonCode, rejectionReason) pair. */
  reasonCounts: ReadonlyArray<{
    reasonCode: string | null;
    rejectionReason: string | null;
    count: number;
  }>;
  /** The newest proposals of the window, at most `DUPLICATE_SAMPLE_LIMIT`. */
  duplicateSample: ReadonlyArray<ScorecardSampleRow>;
}

const isApplied = (status: string) =>
  status === ProposalStatus.APPROVED || status === ProposalStatus.AUTO_APPROVED;

/**
 * Raw rows → the aggregates the DB tier computes in SQL. The reference
 * derivation: a test seeds the same rows in Postgres and the two must agree.
 */
export function scorecardAggregatesFromRows(
  rows: readonly ScorecardProposalRow[]
): ScorecardAggregates {
  const statusCounts = new Map<string, number>();
  const reasonCounts = new Map<
    string,
    { reasonCode: string | null; rejectionReason: string | null; count: number }
  >();
  for (const r of rows) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    const key = JSON.stringify([r.reasonCode, r.rejectionReason]);
    const hit = reasonCounts.get(key);
    if (hit) hit.count += 1;
    else
      reasonCounts.set(key, {
        reasonCode: r.reasonCode,
        rejectionReason: r.rejectionReason,
        count: 1,
      });
  }
  return {
    statusCounts: [...statusCounts].map(([status, count]) => ({
      status,
      count,
    })),
    appliedData: rows.filter((r) => isApplied(r.status)).map((r) => r.data),
    revisionHistories: rows.map((r) => r.revisionHistory),
    reasonCounts: [...reasonCounts.values()],
    duplicateSample: [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, DUPLICATE_SAMPLE_LIMIT),
  };
}

/**
 * PURE scorecard math over raw rows: {@link scorecardAggregatesFromRows} then
 * {@link foldAgentScorecard}. DB-free so the rules are unit-testable: hand it
 * rows, get back counts + rates + the rejection histogram + a duplicate rate
 * (share of the sample in a same-shape cluster > 1).
 */
export function computeAgentScorecard(
  rows: ScorecardProposalRow[],
  opts: {
    agentId: string;
    agentName: string | null;
    agentType: string | null;
    pendingCount: number;
    cap?: number;
    /** Defaults to the window ending now. */
    window?: ScorecardWindow;
  }
): AgentScorecard {
  return foldAgentScorecard(scorecardAggregatesFromRows(rows), {
    ...opts,
    window: opts.window ?? scorecardWindow(new Date()),
  });
}

/** Fold the window's aggregates into the card. The one place the rules apply. */
export function foldAgentScorecard(
  agg: ScorecardAggregates,
  opts: {
    agentId: string;
    agentName: string | null;
    agentType: string | null;
    pendingCount: number;
    cap?: number;
    window: ScorecardWindow;
  }
): AgentScorecard {
  const cap = opts.cap ?? AGENT_PENDING_PROPOSAL_CAP;

  let total = 0;
  let pending = 0;
  let applied = 0;
  let rejected = 0;
  for (const { status, count } of agg.statusCounts) {
    total += count;
    switch (status) {
      case ProposalStatus.PENDING:
      case ProposalStatus.APPROVAL_FAILED:
        pending += count;
        break;
      case ProposalStatus.APPROVED:
      case ProposalStatus.AUTO_APPROVED:
        applied += count;
        break;
      case ProposalStatus.REJECTED:
        rejected += count;
        break;
      default:
        break;
    }
  }

  // PARTIAL APPLY is not an endorsement. Per-item dispositions let a reviewer
  // deny items inside a composite and approve the rest; the row still stores
  // plain `"approved"` (no new status enum). Counting that as a full approval
  // scores "1 of 30 kept" identically to "30 of 30" — so split it out. Mirrors
  // how `withdrawn` is treated in `AgentStanding`: a non-endorsement gets its
  // own bucket rather than being rounded up into `approved`.
  const partiallyApproved = agg.appliedData.filter((d) =>
    isPartiallyApprovedData(d)
  ).length;
  const approved = applied - partiallyApproved;

  const revised = agg.revisionHistories.filter(
    (h) =>
      Array.isArray(h) && h.some((rev) => isHumanRevision(rev, opts.agentId))
  ).length;

  // Bucket key precedence lives in ONE place — `proposalReasonBucket`, shared
  // with the tighten recommender's classifier. This histogram and that
  // classifier MUST agree on what a rejection means; two copies of the rule
  // would drift, which is the defect the scattered dedup implementations
  // already cost us once.
  const reasonHist = new Map<string, number>();
  for (const r of agg.reasonCounts) {
    const bucket = proposalReasonBucket(r.reasonCode, r.rejectionReason);
    if (bucket) reasonHist.set(bucket, (reasonHist.get(bucket) ?? 0) + r.count);
  }

  // Duplicate rate — reuse the EXACT structural fingerprint the review inbox
  // clusters on, so "duplicate" means the same thing everywhere. A row counts
  // as a duplicate if it shares its fingerprint with at least one sibling.
  // Its denominator is the SAMPLE, not the window total.
  const sampleSize = agg.duplicateSample.length;
  const clusters = collapseProposalsToClusters(
    agg.duplicateSample.map((r, i) => ({ ...r, id: String(i) }))
  );
  const inDuplicateCluster = clusters
    .filter((c) => c.count > 1)
    .reduce((sum, c) => sum + c.count, 0);

  const rate = (n: number) => (total > 0 ? Number((n / total).toFixed(4)) : 0);

  const rejectionReasons = [...reasonHist.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    mode: "agent",
    agentId: opts.agentId,
    agentName: opts.agentName,
    agentType: opts.agentType,
    sampled: total,
    window: opts.window,
    duplicateSample: { size: sampleSize, limit: DUPLICATE_SAMPLE_LIMIT },
    counts: { total, pending, approved, partiallyApproved, rejected, revised },
    rates: {
      approveRate: rate(approved),
      partialApproveRate: rate(partiallyApproved),
      rejectRate: rate(rejected),
      reviseRate: rate(revised),
      duplicateRate:
        sampleSize > 0
          ? Number((inDuplicateCluster / sampleSize).toFixed(4))
          : 0,
    },
    rejectionReasons,
    dailyCap: {
      pendingCount: opts.pendingCount,
      cap,
      atOrOverCap: opts.pendingCount >= cap,
    },
  };
}

/**
 * THE agent read floor: may `userId` read this agent-user's identity and
 * scorecard? Its owner (the person who created it) or a pod admin SIGNED IN
 * as themselves — an admin answers for every agent on the pod, but a key
 * acting for an admin (an agent's, or their own API key) does not carry that
 * reach (`isSignedInPerson`, which the router decides). Shared by
 * `agentScorecard` and the resolver's agent probe so "what is this id?" and
 * "show me this agent" can never disagree. A failed admin read throws
 * (`isPodAdmin`), never reads as "not readable".
 */
export async function agentReadableBy(
  agent: { createdByUserId: string | null },
  userId: string,
  viewer: { signedInPerson: boolean }
): Promise<boolean> {
  if (agent.createdByUserId === userId) return true;
  return viewer.signedInPerson && isPodAdmin(userId);
}

/**
 * DB tier: count an agent-user's proposals (USER-floored) over the card's
 * window, then hand the aggregates to the pure `foldAgentScorecard`. Returns an
 * error object when `agentId` is not an agent-user visible to the caller.
 */
export async function agentScorecard(params: {
  userId: string;
  agentId: string;
  /** A person in their own session (`isSignedInPerson`); keys are not. */
  signedInPerson?: boolean;
}): Promise<AgentScorecard | { error: string }> {
  const { userId, agentId } = params;

  const [agent] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentType: users.agentType,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);

  // OWNER-OR-POD-ADMIN FLOOR (`agentReadableBy`). Without it, a guessed agent
  // UUID would leak that agent's name/email/agentType cross-user. Anyone else
  // gets the same answer as an id that is not an agent, so the door never
  // confirms an agent exists.
  if (
    !agent ||
    agent.userType !== "agent" ||
    !(await agentReadableBy(agent, userId, {
      signedInPerson: params.signedInPerson === true,
    }))
  ) {
    return { error: `No agent-user found for id ${agentId}` };
  }

  const window = scorecardWindow(new Date());

  // "How has this agent behaved?" — keyed on the agent, inside the window,
  // floored to what the CALLER can see: LENS **or** OWNERSHIP. An owner sees
  // its writes everywhere they can see (on the lens alone the agent's writes
  // in an unjoinable workspace vanished from its own card); a pod admin
  // reading someone else's agent sees its writes in the spaces the admin can
  // see — the admin floor widens WHO may read the card, never which proposals
  // it counts. Every query below shares this one predicate, so the parts of
  // the card cannot count different sets.
  const inScope = and(
    eq(proposals.agentUserId, agentId),
    gte(proposals.createdAt, new Date(window.from)),
    or(userVisibleWhere(proposals.workspaceId, userId), authoredByUser(userId))
  );

  // Counts are SQL aggregates over the WHOLE window — never a scan of the
  // newest N rows. Only the duplicate rate reads payloads, and it says it is a
  // sample. The partial-apply and human-revision reads fetch only rows that
  // CAN match (a `dispositions` key / a non-empty revision history) and let
  // the one JS rule decide, rather than restating that rule in SQL.
  const [
    statusCounts,
    appliedRows,
    revisionRows,
    reasonCounts,
    duplicateSample,
    pendingCount,
    cap,
  ] = await Promise.all([
    db
      .select({
        status: proposals.status,
        count: drizzleSql<number>`count(*)::int`,
      })
      .from(proposals)
      .where(inScope)
      .groupBy(proposals.status),
    db
      .select({
        dispositions: drizzleSql<unknown>`${proposals.data} -> 'dispositions'`,
      })
      .from(proposals)
      .where(
        and(
          inScope,
          inArray(proposals.status, [
            ProposalStatus.APPROVED,
            ProposalStatus.AUTO_APPROVED,
          ]),
          drizzleSql`(${proposals.data} -> 'dispositions') is not null`
        )
      ),
    db
      .select({ revisionHistory: proposals.revisionHistory })
      .from(proposals)
      .where(
        and(
          inScope,
          drizzleSql`jsonb_typeof(${proposals.revisionHistory}) = 'array'`,
          drizzleSql`${proposals.revisionHistory} <> '[]'::jsonb`
        )
      ),
    db
      .select({
        reasonCode: proposals.reasonCode,
        rejectionReason: proposals.rejectionReason,
        count: drizzleSql<number>`count(*)::int`,
      })
      .from(proposals)
      .where(
        and(
          inScope,
          or(
            isNotNull(proposals.reasonCode),
            isNotNull(proposals.rejectionReason)
          )
        )
      )
      .groupBy(proposals.reasonCode, proposals.rejectionReason),
    db
      .select({
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
        createdAt: proposals.createdAt,
        workspaceId: proposals.workspaceId,
      })
      .from(proposals)
      .where(inScope)
      .orderBy(desc(proposals.createdAt))
      .limit(DUPLICATE_SAMPLE_LIMIT),
    // Daily-cap posture: the cap is per-AGENT (not shared across the owner's
    // roster) and scales with this agent's own trust (base 10, x3 for a
    // proven agent) — see `agentProposalCap()`, the same helper
    // `createProposal` enforces against.
    //
    // Both halves of the posture are the ENFORCER's own functions, called —
    // not re-derived. This query used to be a hand-copied
    // `createdBy = <human> AND agentUserId = <agent>`, the same
    // overloaded-column pair that made the cap inert (see
    // `countPendingAgentProposals`); a reported posture computed by a second
    // copy of the predicate can drift from what the membrane actually
    // enforces, and did.
    countPendingAgentProposals(agentId),
    agentProposalCap(agentId),
  ]);

  return foldAgentScorecard(
    {
      statusCounts,
      appliedData: appliedRows.map((r) => ({ dispositions: r.dispositions })),
      revisionHistories: revisionRows.map((r) => r.revisionHistory),
      reasonCounts,
      duplicateSample,
    },
    {
      agentId,
      agentName: agent.name ?? agent.email ?? null,
      agentType: agent.agentType ?? null,
      pendingCount,
      cap,
      window,
    }
  );
}

/** One agent's standing in the pod-wide trust grid — REAL lifetime totals. */
export interface AgentStanding {
  agentUserId: string;
  agentName: string | null;
  agentType: string | null;
  /** FULL human approvals (approved + auto_approved, nothing denied inside). */
  approved: number;
  /** Subset of `approved` that were auto-approved (no human touched them). */
  autoApproved: number;
  rejected: number;
  reverted: number;
  /** Not scored — pending + approval_failed. */
  pending: number;
  /** Not scored — the agent recalled it. */
  withdrawn: number;
  /**
   * Not scored — the reviewer kept part of the package and DENIED the rest
   * (per-item dispositions; the row still stores plain `"approved"`). Same
   * category as `withdrawn`: not an endorsement, so it is neither a numerator
   * nor a denominator here. Surfaced as its own column instead of silently
   * inflating `approveRate`, which is exactly what counting it as `approved`
   * used to do.
   */
  partiallyApproved: number;
  /** Denominator: FULL approvals + rejected + reverted (genuine clean decisions). */
  scoredTotal: number;
  approveRate: number;
  refuseRate: number;
  /**
   * WRITES in the last {@link RECENT_WRITES_WINDOW_DAYS} days: this agent's
   * proposals that APPLIED (approved or auto-approved, a partial apply
   * included — part of it wrote), created inside the window. What Settings ›
   * Agents shows as "N writes · 7d": how much this agent actually changed
   * lately, as opposed to the lifetime decision counts above.
   */
  writes7d: number;
}

/** The window `AgentStanding.writes7d` counts over. */
export const RECENT_WRITES_WINDOW_DAYS = 7;

/** One `count(*) GROUP BY agent, status, partial, recent` row. */
export interface AgentStatusCountRow {
  agentUserId: string | null;
  status: string;
  isPartial: boolean;
  isRecent: boolean;
  count: number;
}

export interface AgentStatusAcc {
  approved: number;
  autoApproved: number;
  partiallyApproved: number;
  rejected: number;
  reverted: number;
  pending: number;
  withdrawn: number;
  writes7d: number;
}

/**
 * Fold the grouped counts into per-agent buckets. Pure and exported so the
 * bucketing — which status counts where, and what a recent WRITE is — is
 * tested without a database.
 */
export function foldAgentStatusRows(
  rows: readonly AgentStatusCountRow[]
): Map<string, AgentStatusAcc> {
  const byAgent = new Map<string, AgentStatusAcc>();
  for (const r of rows) {
    if (!r.agentUserId) continue;
    const a = byAgent.get(r.agentUserId) ?? {
      approved: 0,
      autoApproved: 0,
      partiallyApproved: 0,
      rejected: 0,
      reverted: 0,
      pending: 0,
      withdrawn: 0,
      writes7d: 0,
    };
    switch (r.status) {
      // A partially-applied row carries status `"approved"`/`"auto_approved"`
      // like any other; only `data.dispositions` distinguishes it. Route it to
      // its own bucket BEFORE it can reach `approved`.
      case ProposalStatus.APPROVED:
        if (r.isPartial) a.partiallyApproved += r.count;
        else a.approved += r.count;
        if (r.isRecent) a.writes7d += r.count;
        break;
      case ProposalStatus.AUTO_APPROVED:
        if (r.isPartial) {
          a.partiallyApproved += r.count;
        } else {
          a.approved += r.count;
          a.autoApproved += r.count;
        }
        if (r.isRecent) a.writes7d += r.count;
        break;
      case ProposalStatus.REJECTED:
        a.rejected += r.count;
        break;
      case ProposalStatus.REVERTED:
        a.reverted += r.count;
        break;
      case ProposalStatus.PENDING:
      case ProposalStatus.APPROVAL_FAILED:
        a.pending += r.count;
        break;
      case ProposalStatus.WITHDRAWN:
        a.withdrawn += r.count;
        break;
      default:
        break;
    }
    byAgent.set(r.agentUserId, a);
  }
  return byAgent;
}

/**
 * The pod-wide trust grid: a REAL `count(*) GROUP BY agent_user_id, status`
 * across every proposal the caller can see, so the numbers are lifetime totals —
 * not a fetched-page slice like the browser's old client-side reduce. Only
 * AGENT-user actors are returned (humans are filtered out by `userType`), keyed
 * on the stable `agentUserId` so two agents that display the same name never
 * collapse. Sorted most-refused-first (highest learning value).
 */
export async function allAgentsScorecard(params: {
  userId: string;
}): Promise<AgentStanding[]> {
  const { userId } = params;

  // USER floor: only proposals in workspaces the caller can see.
  // Partial-apply flag, computed IN SQL because this door aggregates rather
  // than fetching rows (`count(*) GROUP BY`), so there is no `data` to inspect
  // in JS. `jsonb_path_exists` is null-safe and shape-safe: a NULL `data`, a
  // missing `dispositions` key, or a non-object there all yield NULL/false
  // instead of the `cannot deconstruct` error `jsonb_each` would raise. It
  // answers the SAME question as `isPartiallyApprovedData` (the JS door used by
  // `computeAgentScorecard`) — any item disposition whose status is "reject".
  const isPartial = drizzleSql<boolean>`coalesce(jsonb_path_exists(${proposals.data}, '$.dispositions.*.status ? (@ == "reject")'), false)`;

  // The window is inlined as a SQL literal, never a bind parameter: this
  // expression is both SELECTed and GROUPed BY, and Postgres treats `$1` and `$5`
  // as different expressions — "created_at must appear in the GROUP BY clause"
  // (a 500 on the live Agents page, 2026-09-28). The value is a module constant
  // integer, so `sql.raw` carries no injection surface.
  const isRecent = drizzleSql<boolean>`(${proposals.createdAt} > now() - make_interval(days => ${drizzleSql.raw(String(Math.trunc(RECENT_WRITES_WINDOW_DAYS)))}))`;

  const rows = await db
    .select({
      agentUserId: proposals.agentUserId,
      status: proposals.status,
      isPartial,
      isRecent,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(proposals)
    .where(
      and(
        isNotNull(proposals.agentUserId),
        // Same window + floor as `computeAgentScorecard` above: LENS **or**
        // OWNERSHIP. Splitting them would make the pod-wide grid and the
        // per-agent card report different totals for the same agent.
        or(
          userVisibleWhere(proposals.workspaceId, userId),
          authoredByUser(userId)
        )
      )
    )
    .groupBy(proposals.agentUserId, proposals.status, isPartial, isRecent);

  const byAgent = foldAgentStatusRows(rows);

  const ids = [...byAgent.keys()];
  if (ids.length === 0) return [];

  // Resolve identity — DROP non-agent actors (a human owner whose proposals are
  // visible must never show up), AND owner-floor to the caller's OWN agents —
  // the grid is "how are MY agents doing", for an admin too. The per-agent
  // detail doors (`agentProfile`/`agentScorecard`) also admit a pod admin
  // (`agentReadableBy`), so every card here opens; the converse is not needed.
  const identities = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentType: users.agentType,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        eq(users.userType, "agent"),
        eq(users.createdByUserId, userId),
        // An app's agent is governed on its app's page, not ranked here.
        notAnAppAgent(users.id)
      )
    );

  const standings: AgentStanding[] = [];
  for (const ident of identities) {
    const a = byAgent.get(ident.id);
    if (!a) continue;
    const scoredTotal = a.approved + a.rejected + a.reverted;
    const rate = (n: number) =>
      scoredTotal > 0 ? Number((n / scoredTotal).toFixed(4)) : 0;
    standings.push({
      agentUserId: ident.id,
      agentName: ident.name ?? ident.email ?? null,
      agentType: ident.agentType ?? null,
      approved: a.approved,
      autoApproved: a.autoApproved,
      rejected: a.rejected,
      reverted: a.reverted,
      pending: a.pending,
      withdrawn: a.withdrawn,
      partiallyApproved: a.partiallyApproved,
      scoredTotal,
      approveRate: rate(a.approved),
      refuseRate: rate(a.rejected),
      writes7d: a.writes7d,
    });
  }

  // Most-refused-first — the highest learning value.
  standings.sort(
    (x, y) => y.refuseRate - x.refuseRate || y.rejected - x.rejected
  );
  return standings;
}
