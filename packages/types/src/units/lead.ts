/**
 * WHICH REGION OF A UNIT-OF-WORK SURFACE LEADS — derived from what is true NOW.
 *
 * ── Why this is shared, and not two copies ─────────────────────────────────
 * Relay's session room and browser's session room both reorder their body by
 * what the session needs. Both used to pick that order from a STORED playbook
 * type (`playbooks.kind`: interrogation | make | review), each with its own
 * re-declared copy of the union. That column was removed on 2026-09-21: it was
 * set on 0 of 29 playbooks on the live pod, so neither surface had ever chosen
 * a non-default arm in production — and a stored type is STATIC while the work
 * is not. A session producing a deliverable at noon can be waiting on the
 * person at four, and its `kind` would still have said "make".
 *
 * Two surfaces implementing one rule is how this codebase has produced
 * identical-and-wrong twice before (a bucket predicate mirrored perfectly
 * across browser and relay, with the cross-repo tripwire green throughout —
 * sameness is not correctness). So the rule lives HERE, once, beside
 * `resolveUnitState`, whose precedence it borrows. Each surface writes a thin
 * adapter from its own view types to these primitives; neither owns the rule.
 *
 * ── The precedence, and why it is not a local choice ───────────────────────
 * An obligation the reader HOLDS outranks one they merely have to JUDGE. That
 * is exactly `resolveUnitState`'s order (`needs_you` before `needs_review`), so
 * a unit's state chip and its layout can never disagree about what it wants.
 */

/**
 * Which region a surface should lead with.
 *
 * The ARRAY is the declaration and the type is derived from it, so a guard that
 * loops over the leads picks up a new one BY EXISTING. A hand-maintained list
 * beside a union is how this codebase once shipped a scan holding only the one
 * member that was already correct.
 */
export const WORK_LEADS = ["owed", "scorecard", "steps"] as const;
export type WorkLead = (typeof WORK_LEADS)[number];

export interface WorkLeadInput {
  /**
   * How many rows the READER owes — or `null` when the ledger is loading or
   * its read FAILED. `null` is not zero: it is "nobody measured this", and it
   * can never produce an `owed` lead (see below).
   */
  owedCount: number | null;
  /**
   * Some acceptance criterion awaits the reader's grade. `false` also covers
   * an unreadable scorecard: a read that failed asserts no obligation.
   */
  gradeOwed: boolean;
}

/**
 * An unmeasured ledger (`owedCount: null`) can never yield `"owed"` —
 * promoting over a ledger nobody could read would assert an obligation that
 * was never measured.
 *
 * It does NOT force `"steps"`, and that distinction is load-bearing: the
 * scorecard is a SEPARATE read, so a grade genuinely owed still leads. Folding
 * a failed ledger into "show the steps" would hide a real obligation on the
 * strength of an unrelated failure. Only the `owed` lead depends on the ledger,
 * so only the `owed` lead is suppressed.
 */
export function resolveWorkLead(input: WorkLeadInput): WorkLead {
  if ((input.owedCount ?? 0) > 0) return "owed";
  if (input.gradeOwed) return "scorecard";
  return "steps";
}
