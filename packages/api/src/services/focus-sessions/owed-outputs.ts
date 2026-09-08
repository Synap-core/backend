/**
 * OWED OUTPUTS — the pod-wide read for "what is blocked on YOU".
 *
 * An agent that cannot take a deliverable hands the slot to the human
 * (`blockExpectedOutput`): `owner: 'human'` + `blockedReason` + `why` +
 * `owedSince`. That half shipped and is live. This is the other half — reading
 * those slots back, across every session the user owns, so a "needs you" surface
 * exists at all.
 *
 * ── WHY THIS IS NOT COMPOSED OVER `focusSessions.list` ──────────────────────
 * That door is `limit`-capped at 50 in SQL and its own comments forbid
 * post-filtering three times, for the reason that applies here with full force:
 * owed slots ACCUMULATE ON OLD, CLOSED SESSIONS — precisely the rows that fall
 * off page one. A page-then-filter read of this population under-reports
 * silently and gets more wrong the longer the pod is used. So the predicate is a
 * WHERE clause, and the population is every session the user owns regardless of
 * age or status.
 *
 * ── THE PREDICATE, AND THE TRAP IN IT ───────────────────────────────────────
 * `status` is normally ABSENT on a slot — the docblock on `ExpectedOutput.status`
 * says "Absent ⇒ treat as `pending`", and on the live pod 19 of 37 owed slots
 * carry no `status` key at all. So the obvious spellings are BOTH wrong and both
 * fail SILENTLY, returning half the rows:
 *
 *     slot->>'status' != 'done'        -- NULL != 'done' → NULL → row rejected
 *     NOT (slot->>'status' = 'done')   -- NOT NULL       → NULL → row rejected
 *
 * `IS DISTINCT FROM` is the operator that means what it says on a missing key,
 * and it is what `triage.ts` already uses for exactly this shape. `owner`, by
 * contrast, is ALWAYS written explicitly by the block door, so a positive
 * `= 'human'` match on it is complete.
 *
 * ── SQL AND ITS TYPESCRIPT TWIN LIVE IN ONE FILE ────────────────────────────
 * The same rule `triage.ts` states: the predicate exists exactly twice — once as
 * SQL (the WHERE clause, so the read is complete) and once in TypeScript
 * (`isOwedSlot`, which picks the slots back out of the rows the SQL returned).
 * They MUST agree, so they are kept side by side; a copy in a router is how the
 * two fork.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * `owedSince` is the ordering key (oldest first) and the reason it exists:
 * `focus_sessions.updatedAt` cannot serve, because any unrelated write to the
 * session would resurface an owed slot to the top forever.
 *
 * Rows are ordered in SQL by the session's OLDEST owed slot, then the flattened
 * slots are ordered again in TypeScript — the row order alone cannot order slots
 * that share a session. Comparing `owedSince` as TEXT is chronological here
 * because every stamp is written by `new Date().toISOString()`: fixed-width,
 * UTC, `Z`-suffixed ISO-8601, which sorts lexicographically iff it sorts
 * chronologically. Nothing else may write the field (`reconcileOwedSince` owns
 * the invariant), so that is a property of the system, not a hope.
 */

import { db, focusSessions, and, eq, drizzleSql } from "@synap/database";
import type { SQL } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import type { ResolvedScope } from "../../utils/scope-filter.js";
import { sessionScopeConditions } from "./session-scope.js";

/**
 * SQL: sessions carrying at least one slot that is still owed by the human.
 *
 * The `jsonb_typeof` guard is the same one `identity-resolution-service.ts`
 * carries in production: `jsonb_array_elements` ERRORS on a non-array value, and
 * `expected_outputs` is untyped JSONB that a legacy row can hold anything in.
 */
export function owedSlotWhere(): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${focusSessions.expectedOutputs}) = 'array'
           THEN ${focusSessions.expectedOutputs}
           ELSE '[]'::jsonb END
    ) AS slot
    WHERE slot->>'owner' = 'human'
      AND slot->>'status' IS DISTINCT FROM 'done'
      AND slot->>'retiredAt' IS NULL
  )`;
}

/**
 * SQL: an index-usable POSITIVE PREFILTER, and nothing more.
 *
 * `@>` containment is the only part of the predicate a GIN/partial index can
 * serve, and it can only express a positive match — it cannot say
 * "status is not done". So it narrows the candidate set to sessions that have
 * ever handed a slot to the human, and {@link owedSlotWhere} then decides. It is
 * SAFE to AND in only because `owner: 'human'` is always written explicitly:
 * a slot this misses could not have matched the exact predicate either.
 *
 * Paired with the partial index in migration 0250. Dropping the index makes this
 * a redundant-but-correct clause, never a wrong answer.
 */
export function owedSlotPrefilter(): SQL {
  return drizzleSql`${focusSessions.expectedOutputs} @> '[{"owner": "human"}]'::jsonb`;
}

/**
 * SQL: rank a session by its OLDEST owed slot — the twin of the TypeScript sort
 * at the end of {@link listOwedSlots}, and exported so the two can be compared.
 *
 * `coalesce(..., MISSING_OWED_SINCE)` is load-bearing, not cosmetic. `min()`
 * SKIPS NULLs, so a session holding one UNSTAMPED slot and one stamped
 * `2026-09-01` ranked by the September date — while the TypeScript sort places
 * that unstamped slot FIRST of everything, via the same sentinel. The two
 * orderings disagreed on exactly the anomalous row, and because this ORDER BY
 * decides which rows survive `.limit()`, the globally-oldest slot was the one
 * the page could silently drop. One sentinel, both orderings.
 *
 * `NULLS FIRST` is kept as a belt: with the coalesce in place the expression can
 * only be NULL when a session matched the WHERE but yields no slot here, which
 * the shared predicate makes unreachable.
 */
export function owedSlotOrder(): SQL {
  return drizzleSql`(
    SELECT min(coalesce(slot->>'owedSince', ${MISSING_OWED_SINCE})) FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${focusSessions.expectedOutputs}) = 'array'
           THEN ${focusSessions.expectedOutputs}
           ELSE '[]'::jsonb END
    ) AS slot
    WHERE slot->>'owner' = 'human'
      AND slot->>'status' IS DISTINCT FROM 'done'
      AND slot->>'retiredAt' IS NULL
  ) ASC NULLS FIRST`;
}

/**
 * THE derivation in TypeScript — the twin of {@link owedSlotWhere}, kept in this
 * file so the two cannot drift.
 *
 * `status !== "done"` rather than `=== "pending"` for the same reason the SQL
 * uses `IS DISTINCT FROM`: absent is the common case and means pending.
 */
export function isOwedSlot(slot: ExpectedOutput): boolean {
  return (
    slot.owner === "human" && slot.status !== "done" && slot.retiredAt == null
  );
}

/**
 * The sort key for a slot with NO `owedSince` — an anomaly the invariant should
 * make impossible, but which a legacy row or a write around the doors can still
 * produce. It must sort BEFORE every real stamp (an unorderable slot is shown at
 * the top, where an anomaly belongs, never buried as if it were new), and it is
 * shared by BOTH orderings — the SQL `ORDER BY` that decides which rows survive
 * the page limit, and the TypeScript sort that orders the flattened slots. A
 * sentinel used by only one of the two is how they disagreed.
 *
 * `signalFromOwedSlot` maps it to the epoch (it is an Invalid Date, and NaN
 * loses every comparison silently) — the same intent, one layer up.
 */
export const MISSING_OWED_SINCE = "0000-00-00";

/** One owed deliverable, with just enough of its session to be actionable. */
export interface OwedSlot {
  sessionId: string;
  sessionGoal: string | null;
  /** The session's lifecycle state — an owed slot outlives its session. */
  sessionStatus: string;
  workspaceId: string | null;
  projectId: string | null;
  /** The DECLARED label — the key every slot door matches on. */
  label: string;
  kind: string;
  icon?: string;
  blockedReason?: ExpectedOutput["blockedReason"];
  /** One line naming WHICH thing is missing. */
  why?: string;
  /** When it became the human's. Always present — the invariant guarantees it. */
  owedSince: string;
  /** The agent's claim that it produced this after all, if it made one. */
  claimedDone?: boolean;
}

export interface ListOwedSlotsParams {
  /** Owner floor. `focus_sessions` is owner-private; this is never optional. */
  userId: string;
  scope: ResolvedScope;
  /** Cap on SLOTS returned, not on sessions scanned. */
  limit: number;
}

type OwedRow = {
  id: string;
  goal: string | null;
  status: string;
  workspaceId: string | null;
  projectId: string | null;
  expectedOutputs: unknown;
};

/**
 * Flatten one session's slot array into the owed ones. Pure, so the projection
 * is testable without a database.
 */
export function projectOwedSlots(row: OwedRow): OwedSlot[] {
  const outputs: ExpectedOutput[] = Array.isArray(row.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  const owed: OwedSlot[] = [];
  for (const slot of outputs) {
    if (!slot || typeof slot !== "object") continue;
    if (!isOwedSlot(slot)) continue;
    // The invariant (`owedSince` present IFF `owner === 'human'`) is enforced on
    // every write path, but this read must not INVENT a timestamp for a row that
    // predates it or was written around the doors: a slot with no stamp cannot
    // be ordered, and silently sorting it as "now" would bury the oldest work.
    // Skipping it would hide it, so it sorts as the OLDEST thing there is —
    // visible, and at the top where an anomaly belongs.
    const owedSince =
      typeof slot.owedSince === "string" ? slot.owedSince : MISSING_OWED_SINCE;
    owed.push({
      sessionId: row.id,
      sessionGoal: row.goal,
      sessionStatus: row.status,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      label: slot.label,
      kind: slot.kind,
      ...(slot.icon !== undefined ? { icon: slot.icon } : {}),
      ...(slot.blockedReason !== undefined
        ? { blockedReason: slot.blockedReason }
        : {}),
      ...(slot.why !== undefined ? { why: slot.why } : {}),
      owedSince,
      ...(slot.claimedDone !== undefined
        ? { claimedDone: slot.claimedDone }
        : {}),
    });
  }
  return owed;
}

/**
 * Every slot owed by this user, oldest first — across every session they own,
 * open or closed, in any workspace the lens allows.
 *
 * NO status filter, deliberately. A slot handed to the human on a session that
 * has since closed / failed / gone stale is STILL owed: the work was declared,
 * the session ended, and somebody still has to do it. The only exit besides
 * doing it is `cancelled`, which STAMPS `retiredAt` on the way out
 * (`complete-session.ts`) and so drops out of the predicate above — a receipt,
 * never a delete.
 */
export async function listOwedSlots(
  params: ListOwedSlotsParams
): Promise<OwedSlot[]> {
  const { userId, scope, limit } = params;

  const conditions: SQL[] = [
    eq(focusSessions.userId, userId),
    ...sessionScopeConditions(scope),
    owedSlotPrefilter(),
    owedSlotWhere(),
  ];

  const rows = await db
    .select({
      id: focusSessions.id,
      goal: focusSessions.goal,
      status: focusSessions.status,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(and(...conditions))
    // Oldest owed slot first, computed from the same predicate the WHERE uses.
    // Rows are capped at `limit` because a session yields at least one slot, so
    // `limit` rows can never yield fewer than `limit` slots when more exist —
    // and the ones this cuts are, by this ordering, the NEWEST.
    .orderBy(owedSlotOrder())
    .limit(limit);

  return rows
    .flatMap((r) => projectOwedSlots(r as OwedRow))
    .sort((a, b) =>
      a.owedSince < b.owedSince ? -1 : a.owedSince > b.owedSince ? 1 : 0
    )
    .slice(0, limit);
}

/**
 * Stamp the retirement receipt on every still-owed slot. Pure.
 *
 * Slots that are done, already retired, or agent-owned are untouched: this
 * records that the CANCELLATION is why the human no longer owes them, and that
 * is only true of the ones they still owed.
 */
export function stampRetired(
  outputs: ExpectedOutput[],
  reason: ExpectedOutput["retiredReason"],
  now: Date = new Date()
): ExpectedOutput[] {
  const at = now.toISOString();
  return outputs.map((o) =>
    o && typeof o === "object" && isOwedSlot(o)
      ? { ...o, retiredAt: at, retiredReason: reason }
      : o
  );
}

/**
 * WHAT A CLOSE DOES TO THE OWED SLOTS — the rule, pure, so "which terminal
 * status retires" is testable without a database and cannot be re-decided
 * inline at the close door.
 *
 * Returns `null` when nothing changes, which is the answer for every exit but
 * one: `closed` and `failed` LEAVE the slots owed (the work was declared, the
 * session ended, somebody still has to do it), and `stale` never reaches the
 * close door at all — the reaper stamps it directly — so its slots survive for
 * the same reason, by design rather than by accident.
 *
 * `cancelled` is the only exit that ends the obligation, and it stamps.
 */
export function retirementForClose(
  outputs: ExpectedOutput[],
  terminalStatus: "closed" | "cancelled" | "failed",
  now: Date = new Date()
): { outputs: ExpectedOutput[]; retiredSlots: number } | null {
  if (terminalStatus !== "cancelled") return null;
  const retiredSlots = outputs.filter(
    (o) => o && typeof o === "object" && isOwedSlot(o)
  ).length;
  if (retiredSlots === 0) return null;
  return {
    outputs: stampRetired(outputs, "session_cancelled", now),
    retiredSlots,
  };
}
