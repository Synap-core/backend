/**
 * Quality per prompt version — "did the prompt change make extraction better or
 * worse?", answered from what the humans did with the proposals.
 *
 * An intake run IS a session carrying `metadata.run` (the manifest written by
 * `recordSessionRunManifest`), and proposals carry `sessionId`. So the join is
 * session → manifest facts (promptVersion, engine, model) → the session's
 * proposals → their review outcome. Nothing new is classified here: the status
 * split is `agent-scorecard`'s / `review-queue`'s, partial approval is
 * `isPartiallyApprovedData`, the reject reason is `proposalReasonBucket`.
 *
 * ── THE DENOMINATOR ─────────────────────────────────────────────────────────
 * `decided` = proposals a HUMAN decided: `approved` (in full) +
 * `partiallyApproved` (approved with items denied) + `rejected` — the
 * `review-queue` definition. NOT counted:
 *   - `pending` / `approval_failed` — nobody decided yet.
 *   - `auto_approved` — never reached a human, so it says nothing about the
 *     prompt's quality; worse, turning auto-apply on for one version would make
 *     that version look better. Reported alongside as `autoApproved`.
 *   - `withdrawn` / `expired` / `reverted` — `notScored`.
 * `rejectRate = rejected / decided`, `null` when `decided === 0` (never a
 * fabricated 0). `reasonedRejectRate = reasonedRejects / rejected`, `null` when
 * nothing was rejected.
 *
 * ── GROUPING ────────────────────────────────────────────────────────────────
 * One group per (promptVersion, engine, model). A manifest from an older IS
 * reads `"unknown"` — it is its own group, never dropped and never merged into
 * a real version. A regression compares versions only WITHIN one
 * (engine, model), so a model swap is never read as a prompt regression.
 *
 * ── REGRESSION (the loop's trigger) ─────────────────────────────────────────
 * For each (engine, model), order its comparable versions by first-seen run;
 * the newest is compared with the one before it. A regression requires BOTH:
 *   - `MIN_DECIDED_PER_VERSION` human decisions on EACH side — below that the
 *     rate is noise and no one is told anything;
 *   - `MIN_REJECT_RATE_DELTA` absolute increase in `rejectRate`.
 * Both are hypotheses with a knob, deliberately conservative: a false alarm to
 * the pod admin costs attention and trust. Instrument before tuning.
 *
 * LIMIT: rates are proposal-level. A capture that files ONE composite proposal
 * per run scores item-level denial only as `partiallyApproved` (and in
 * `itemsDenied`); it does not move `rejectRate`.
 *
 * LENS: `userId` floors on the session OWNER (`focus_sessions.user_id`) — the
 * diagnose door passes the caller. `userId: null` is POD-WIDE and exists only
 * for the regression cron, which reports to pod admins.
 */

import {
  countRejectedDispositions,
  isPartiallyApprovedData,
} from "@synap-core/types/proposals";
import {
  db,
  and,
  eq,
  gte,
  desc,
  inArray,
  drizzleSql,
  focusSessions,
  proposals,
  ProposalStatus,
} from "@synap/database";
import {
  proposalReasonBucket,
  UNKNOWN_REASON,
} from "../proposals/reason-bucket.js";
import { readSessionRunManifest } from "./record-session-run-manifest.js";
import { isHumanRevision } from "../diagnose/agent-scorecard.js";

/** Default look-back for the report. */
export const QUALITY_WINDOW_DAYS = 30;
/** Per side of a comparison: fewer human decisions than this ⇒ no verdict. */
export const MIN_DECIDED_PER_VERSION = 20;
/** Absolute `rejectRate` increase (newer − previous) that counts as worse. */
export const MIN_REJECT_RATE_DELTA = 0.15;
/** Versions that name no prompt — reported, never compared. */
export const NON_COMPARABLE_PROMPT_VERSIONS: ReadonlySet<string> = new Set([
  "unknown",
  "none",
]);

const SESSION_SCAN_LIMIT = 2000;
const PROPOSAL_SCAN_LIMIT = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface QualitySessionRow {
  id: string;
  createdAt: Date;
  promptVersion: string;
  engine: string;
  model: string | null;
}

export interface QualityProposalRow {
  sessionId: string;
  status: string;
  data: unknown;
  reasonCode: string | null;
  rejectionReason: string | null;
  revisionHistory: unknown;
}

export interface PromptVersionQuality {
  promptVersion: string;
  engine: string;
  model: string | null;
  runs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  proposals: {
    total: number;
    pending: number;
    approved: number;
    partiallyApproved: number;
    rejected: number;
    autoApproved: number;
    notScored: number;
    revised: number;
  };
  /** Items denied inside approved composites (per-item dispositions). */
  itemsDenied: number;
  decided: number;
  rejectRate: number | null;
  reasonedRejects: number;
  reasonedRejectRate: number | null;
  rejectionReasons: Array<{ reason: string; count: number }>;
}

export interface PromptVersionRegression {
  engine: string;
  model: string | null;
  previous: { promptVersion: string; decided: number; rejectRate: number };
  newer: { promptVersion: string; decided: number; rejectRate: number };
  delta: number;
}

export interface QualityByPromptVersion {
  windowDays: number;
  since: string;
  runs: number;
  groups: PromptVersionQuality[];
  regressions: PromptVersionRegression[];
  /** A scan hit its cap — the counts cover the most recent rows only. */
  truncated: { sessions: boolean; proposals: boolean };
}

const rate = (n: number, d: number) =>
  d > 0 ? Number((n / d).toFixed(4)) : null;

/** A revision a HUMAN made — the `agent-scorecard` rule without a subject agent. */
function hasHumanRevision(history: unknown): boolean {
  return Array.isArray(history) && history.some((rev) => isHumanRevision(rev));
}

/** PURE: group runs + their proposals by (promptVersion, engine, model). */
export function computeQualityByPromptVersion(
  sessions: QualitySessionRow[],
  proposalRows: QualityProposalRow[]
): PromptVersionQuality[] {
  const keyOf = (s: QualitySessionRow) =>
    JSON.stringify([s.promptVersion, s.engine, s.model]);

  type Acc = PromptVersionQuality & { reasons: Map<string, number> };
  const groups = new Map<string, Acc>();
  const groupBySession = new Map<string, Acc>();

  for (const s of sessions) {
    const key = keyOf(s);
    let g = groups.get(key);
    const at = s.createdAt.toISOString();
    if (!g) {
      g = {
        promptVersion: s.promptVersion,
        engine: s.engine,
        model: s.model,
        runs: 0,
        firstSeenAt: at,
        lastSeenAt: at,
        proposals: {
          total: 0,
          pending: 0,
          approved: 0,
          partiallyApproved: 0,
          rejected: 0,
          autoApproved: 0,
          notScored: 0,
          revised: 0,
        },
        itemsDenied: 0,
        decided: 0,
        rejectRate: null,
        reasonedRejects: 0,
        reasonedRejectRate: null,
        rejectionReasons: [],
        reasons: new Map(),
      };
      groups.set(key, g);
    }
    g.runs += 1;
    if (at < g.firstSeenAt) g.firstSeenAt = at;
    if (at > g.lastSeenAt) g.lastSeenAt = at;
    groupBySession.set(s.id, g);
  }

  for (const p of proposalRows) {
    const g = groupBySession.get(p.sessionId);
    if (!g) continue;
    const c = g.proposals;
    c.total += 1;
    switch (p.status) {
      case ProposalStatus.PENDING:
      case ProposalStatus.APPROVAL_FAILED:
        c.pending += 1;
        break;
      case ProposalStatus.APPROVED:
        if (isPartiallyApprovedData(p.data)) c.partiallyApproved += 1;
        else c.approved += 1;
        g.itemsDenied += countRejectedDispositions(p.data);
        break;
      case ProposalStatus.AUTO_APPROVED:
        c.autoApproved += 1;
        break;
      case ProposalStatus.REJECTED: {
        c.rejected += 1;
        const bucket = proposalReasonBucket(p.reasonCode, p.rejectionReason);
        if (bucket) g.reasonedRejects += 1;
        const k = bucket ?? UNKNOWN_REASON;
        g.reasons.set(k, (g.reasons.get(k) ?? 0) + 1);
        break;
      }
      default:
        c.notScored += 1;
    }
    if (hasHumanRevision(p.revisionHistory)) c.revised += 1;
  }

  return [...groups.values()]
    .map(({ reasons, ...g }) => {
      const decided =
        g.proposals.approved +
        g.proposals.partiallyApproved +
        g.proposals.rejected;
      return {
        ...g,
        decided,
        rejectRate: rate(g.proposals.rejected, decided),
        reasonedRejectRate: rate(g.reasonedRejects, g.proposals.rejected),
        rejectionReasons: [...reasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
          .slice(0, 10),
      };
    })
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

/** PURE: newest comparable version vs the one before it, per (engine, model). */
export function detectPromptVersionRegressions(
  groups: PromptVersionQuality[]
): PromptVersionRegression[] {
  const byLine = new Map<string, PromptVersionQuality[]>();
  for (const g of groups) {
    if (NON_COMPARABLE_PROMPT_VERSIONS.has(g.promptVersion)) continue;
    const key = JSON.stringify([g.engine, g.model]);
    byLine.set(key, [...(byLine.get(key) ?? []), g]);
  }
  const out: PromptVersionRegression[] = [];
  for (const line of byLine.values()) {
    if (line.length < 2) continue;
    const ordered = [...line].sort((a, b) =>
      a.firstSeenAt.localeCompare(b.firstSeenAt)
    );
    const newer = ordered[ordered.length - 1]!;
    const previous = ordered[ordered.length - 2]!;
    if (
      newer.decided < MIN_DECIDED_PER_VERSION ||
      previous.decided < MIN_DECIDED_PER_VERSION ||
      newer.rejectRate === null ||
      previous.rejectRate === null
    )
      continue;
    const delta = newer.rejectRate - previous.rejectRate;
    // Integer basis points: in floats 0.35 - 0.20 = 0.14999999999999997, which
    // would silently miss a delta the docblock promises is >= 0.15.
    if (Math.round(delta * 1e4) < Math.round(MIN_REJECT_RATE_DELTA * 1e4)) {
      continue;
    }
    out.push({
      engine: newer.engine,
      model: newer.model,
      previous: {
        promptVersion: previous.promptVersion,
        decided: previous.decided,
        rejectRate: previous.rejectRate,
      },
      newer: {
        promptVersion: newer.promptVersion,
        decided: newer.decided,
        rejectRate: newer.rejectRate,
      },
      delta: Number(delta.toFixed(4)),
    });
  }
  return out;
}

/**
 * DB tier. THROWS on a failed read — callers decide how to surface it (the
 * diagnose door marks the section unavailable; the cron job fails).
 */
export async function gatherQualityByPromptVersion(params: {
  userId: string | null;
  workspaceId?: string | null;
  windowDays?: number;
  now?: Date;
}): Promise<QualityByPromptVersion> {
  const windowDays = params.windowDays ?? QUALITY_WINDOW_DAYS;
  const since = new Date(
    (params.now ?? new Date()).getTime() - windowDays * DAY_MS
  );

  // SESSION-KIND-LENS-EXEMPT: narrow projection (id, createdAt, metadata->run) aggregated into counts — no session row is ever returned to a consumer.
  const sessionRows = await db
    .select({
      id: focusSessions.id,
      createdAt: focusSessions.createdAt,
      run: drizzleSql<unknown>`${focusSessions.metadata} -> 'run'`,
    })
    .from(focusSessions)
    .where(
      and(
        gte(focusSessions.createdAt, since),
        drizzleSql`(${focusSessions.metadata} -> 'run') is not null`,
        params.userId ? eq(focusSessions.userId, params.userId) : undefined,
        params.workspaceId
          ? eq(focusSessions.workspaceId, params.workspaceId)
          : undefined
      )
    )
    .orderBy(desc(focusSessions.createdAt))
    .limit(SESSION_SCAN_LIMIT + 1);

  const truncatedSessions = sessionRows.length > SESSION_SCAN_LIMIT;
  const sessions: QualitySessionRow[] = [];
  for (const row of sessionRows.slice(0, SESSION_SCAN_LIMIT)) {
    const manifest = readSessionRunManifest({ run: row.run });
    if (!manifest) continue;
    sessions.push({
      id: row.id,
      createdAt: new Date(row.createdAt),
      promptVersion: manifest.promptVersion,
      engine: manifest.engine,
      model: manifest.model,
    });
  }

  const proposalRows =
    sessions.length === 0
      ? []
      : await db
          .select({
            sessionId: proposals.sessionId,
            status: proposals.status,
            data: proposals.data,
            reasonCode: proposals.reasonCode,
            rejectionReason: proposals.rejectionReason,
            revisionHistory: proposals.revisionHistory,
          })
          .from(proposals)
          .where(
            inArray(
              proposals.sessionId,
              sessions.map((s) => s.id)
            )
          )
          .orderBy(desc(proposals.createdAt))
          .limit(PROPOSAL_SCAN_LIMIT + 1);

  const truncatedProposals = proposalRows.length > PROPOSAL_SCAN_LIMIT;
  const scored: QualityProposalRow[] = [];
  for (const p of proposalRows.slice(0, PROPOSAL_SCAN_LIMIT)) {
    // `inArray` on session ids means a null never matches; narrowed, not cast.
    if (p.sessionId === null) continue;
    scored.push({
      sessionId: p.sessionId,
      status: p.status,
      data: p.data,
      reasonCode: p.reasonCode,
      rejectionReason: p.rejectionReason,
      revisionHistory: p.revisionHistory,
    });
  }
  const groups = computeQualityByPromptVersion(sessions, scored);

  return {
    windowDays,
    since: since.toISOString(),
    runs: sessions.length,
    groups,
    regressions: detectPromptVersionRegressions(groups),
    truncated: { sessions: truncatedSessions, proposals: truncatedProposals },
  };
}
